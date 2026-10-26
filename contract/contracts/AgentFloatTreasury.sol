// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ---------------------------------------------------------------------------
// AgentFloat — AgentFloatTreasury
//
// A budget-controlled MUSD treasury for AI agents on Mezo.
//
// DESIGN NOTE (read this before auditing the control flow)
// -------------------------------------------------------
// x402 payments on Mezo are authorised by an EIP-712 permit2 signature from the
// payer. A contract cannot produce that signature — it has no private key. So
// the paying wallet MUST be an EOA ("the agent wallet").
//
// That means an on-chain contract cannot veto an individual x402 payment made by
// an agent EOA that already holds MUSD. What it CAN do — and what this contract
// does — is enforce the hard cap that actually bounds the damage:
//
//     an agent can never spend more than the treasury releases to it.
//
// Enforcement is therefore layered:
//   1. This contract: per-call max, per-day funding cap, allowlist, pause, and
//      an emergency recall that pulls unspent float back. On-chain, verifiable,
//      not bypassable by the agent or by a compromised gateway.
//   2. The gateway (off-chain): refuses to sign payments that breach policy.
//      Fast, expressive, but trusted — see the limitations in README.
//
// MUSD on Mezo testnet is `permit2` + EIP-2612, so `recallFromAgent` also works
// if the allowance was granted by a gasless permit instead of an approve tx.
//
// Deliberately dependency-free (no OpenZeppelin) to keep the deploy surface and
// the `evmVersion: london` constraint fully under control.
// ---------------------------------------------------------------------------

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

contract AgentFloatTreasury {
    // ---------------------------------------------------------------- types

    /// @notice Policy + cumulative counters for one registered agent wallet.
    struct Agent {
        bool     active;        // registered and not disabled
        uint64   registeredAt;  // unix seconds
        address  gateway;       // off-chain service authorised to write receipts
        uint128  perCallMax;    // max MUSD (wei) releasable in one funding tx
        uint128  dailyCap;      // max MUSD (wei) releasable per UTC day
        uint128  dayFunded;     // MUSD released so far in `dayIndex`
        uint64   dayIndex;      // block.timestamp / 1 days, for lazy rollover
        uint256  totalFunded;   // lifetime MUSD released to this agent
        uint256  totalRecalled; // lifetime MUSD pulled back from this agent
    }

    /// @notice An on-chain receipt for one settled x402 payment.
    struct Payment {
        address agent;
        address payee;
        uint256 amount;          // MUSD wei
        uint64  timestamp;
        bytes32 settlementTx;    // on-chain tx hash the facilitator settled with
        string  endpoint;        // the paid URL
    }

    /// @notice An on-chain record of a payment the policy layer REFUSED.
    struct Denial {
        address agent;
        uint256 attempted;       // MUSD wei the agent tried to spend
        uint64  timestamp;
        string  endpoint;
        string  reason;          // e.g. "per_call_max", "daily_cap", "paused"
    }

    // ---------------------------------------------------------------- state

    /// @notice The MUSD token this treasury holds. Immutable: one asset, one treasury.
    IERC20 public immutable musd;

    address public owner;
    address public pendingOwner;

    /// @notice Master pause. When true, no further MUSD is released to any agent.
    ///         Deposits, owner withdrawals and emergency recalls still work —
    ///         pausing must never trap the operator's funds.
    bool public paused;

    mapping(address => Agent) private _agents;
    address[] private _agentList;

    Payment[] private _payments;
    mapping(address => uint256[]) private _paymentsByAgent;

    Denial[] private _denials;
    mapping(address => uint256[]) private _denialsByAgent;

    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public totalFunded;
    uint256 public totalRecalled;
    uint256 public paymentCount;
    uint256 public denialCount;

    string public constant VERSION = "1.0.0";

    // -------------------------------------------------------------- events

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event AgentRegistered(address indexed agent, address indexed gateway, uint128 perCallMax, uint128 dailyCap);
    event AgentLimitsUpdated(address indexed agent, uint128 perCallMax, uint128 dailyCap);
    event AgentGatewayUpdated(address indexed agent, address indexed gateway);
    event AgentActiveUpdated(address indexed agent, bool active);
    event AgentFunded(address indexed agent, uint256 amount, uint256 dayFunded, uint256 dailyCap);
    event AgentRecalled(address indexed agent, uint256 amount, uint256 remaining);
    event EmergencyStop(address indexed agent, uint256 recalled);
    event PaymentRecorded(address indexed agent, address indexed payee, uint256 amount, bytes32 settlementTx, uint256 index);
    event DenialRecorded(address indexed agent, uint256 attempted, string reason, uint256 index);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // -------------------------------------------------------------- errors

    error NotOwner();
    error NotPendingOwner();
    error NotGateway();
    error ZeroAddress();
    error AlreadyRegistered();
    error NotRegistered();
    error AgentInactive();
    error EnforcedPause();
    error ZeroAmount();
    error ExceedsPerCallMax(uint256 amount, uint256 perCallMax);
    error ExceedsDailyCap(uint256 requested, uint256 remainingToday);
    error InsufficientTreasuryBalance(uint256 requested, uint256 available);
    error InsufficientAllowance(uint256 needed, uint256 granted);
    error TransferFailed();

    // ----------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    // ---------------------------------------------------------- constructor

    /// @param musd_  MUSD token address. On Mezo testnet this MUST be
    ///               0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 — a second
    ///               token also calling itself MUSD exists on testnet and x402
    ///               will not settle in it. See DEPLOYMENT-BRIEF.md §3.
    /// @param owner_ Human operator wallet. Kept separate from every agent key.
    constructor(address musd_, address owner_) {
        if (musd_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        musd = IERC20(musd_);
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ------------------------------------------------------------- custody

    /// @notice Pull MUSD into the treasury. Caller must have approved this contract.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 allowed = musd.allowance(msg.sender, address(this));
        if (allowed < amount) revert InsufficientAllowance(amount, allowed);

        totalDeposited += amount;
        // MUSD is a well-behaved ERC20, but keep effects before interactions.
        if (!musd.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, amount);
    }

    /// @notice Owner pulls MUSD back out. Works while paused so funds can never be trapped.
    function withdrawTo(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = musd.balanceOf(address(this));
        if (amount > bal) revert InsufficientTreasuryBalance(amount, bal);

        totalWithdrawn += amount;
        if (!musd.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    /// @notice MUSD currently held by the treasury.
    function treasuryBalance() public view returns (uint256) {
        return musd.balanceOf(address(this));
    }

    // -------------------------------------------------------- agent policy

    /// @notice Register an agent wallet and set its spending policy.
    function registerAgent(
        address agent,
        address gateway,
        uint128 perCallMax,
        uint128 dailyCap
    ) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        if (_agents[agent].registeredAt != 0) revert AlreadyRegistered();
        if (dailyCap < perCallMax) revert ExceedsDailyCap(perCallMax, dailyCap);

        _agents[agent] = Agent({
            active: true,
            registeredAt: uint64(block.timestamp),
            gateway: gateway,
            perCallMax: perCallMax,
            dailyCap: dailyCap,
            dayFunded: 0,
            dayIndex: _today(),
            totalFunded: 0,
            totalRecalled: 0
        });
        _agentList.push(agent);

        emit AgentRegistered(agent, gateway, perCallMax, dailyCap);
    }

    /// @notice Update an agent's caps. Lowering `dailyCap` below today's spend is
    ///         allowed and immediately blocks further funding — that is the point.
    function setAgentLimits(address agent, uint128 perCallMax, uint128 dailyCap) external onlyOwner {
        Agent storage a = _requireAgent(agent);
        if (dailyCap < perCallMax) revert ExceedsDailyCap(perCallMax, dailyCap);
        a.perCallMax = perCallMax;
        a.dailyCap = dailyCap;
        emit AgentLimitsUpdated(agent, perCallMax, dailyCap);
    }

    /// @notice Point an agent at a different gateway service.
    function setGateway(address agent, address gateway) external onlyOwner {
        Agent storage a = _requireAgent(agent);
        a.gateway = gateway;
        emit AgentGatewayUpdated(agent, gateway);
    }

    /// @notice Enable or disable an agent without deleting its history.
    function setAgentActive(address agent, bool active) external onlyOwner {
        Agent storage a = _requireAgent(agent);
        a.active = active;
        emit AgentActiveUpdated(agent, active);
    }

    /// @notice Release MUSD to an agent wallet, enforcing every cap.
    /// @dev This is the on-chain chokepoint. An agent can only ever spend what
    ///      has passed through here, so these limits are a real hard cap.
    function fundAgent(address agent, uint256 amount) external onlyOwner whenNotPaused {
        Agent storage a = _requireAgent(agent);
        if (!a.active) revert AgentInactive();
        if (amount == 0) revert ZeroAmount();
        if (amount > a.perCallMax) revert ExceedsPerCallMax(amount, a.perCallMax);

        // Lazy UTC-day rollover.
        uint64 today = _today();
        if (a.dayIndex != today) {
            a.dayIndex = today;
            a.dayFunded = 0;
        }

        // Saturating subtraction: an operator may lower `dailyCap` below what has
        // already been released today. That must block cleanly, not underflow.
        uint256 cap = uint256(a.dailyCap);
        uint256 spent = uint256(a.dayFunded);
        uint256 remainingToday = cap > spent ? cap - spent : 0;
        if (amount > remainingToday) revert ExceedsDailyCap(amount, remainingToday);

        uint256 bal = musd.balanceOf(address(this));
        if (amount > bal) revert InsufficientTreasuryBalance(amount, bal);

        a.dayFunded += uint128(amount);
        a.totalFunded += amount;
        totalFunded += amount;

        if (!musd.transfer(agent, amount)) revert TransferFailed();
        emit AgentFunded(agent, amount, a.dayFunded, a.dailyCap);
    }

    /// @notice Pull unspent MUSD back from an agent wallet.
    /// @dev Requires the agent to have granted this contract an allowance, either
    ///      via a normal `approve` or via a gasless EIP-2612 permit (MUSD
    ///      supports both). Works while paused: this is the kill switch.
    function recallFromAgent(address agent, uint256 amount) public onlyOwner {
        Agent storage a = _requireAgent(agent);
        if (amount == 0) revert ZeroAmount();

        uint256 held = musd.balanceOf(agent);
        uint256 take = amount > held ? held : amount;
        if (take == 0) revert ZeroAmount();

        uint256 allowed = musd.allowance(agent, address(this));
        if (allowed < take) revert InsufficientAllowance(take, allowed);

        a.totalRecalled += take;
        totalRecalled += take;

        if (!musd.transferFrom(agent, address(this), take)) revert TransferFailed();
        emit AgentRecalled(agent, take, musd.balanceOf(agent));
    }

    /// @notice The dashboard's big red button: pause all funding AND sweep every
    ///         wei of MUSD back out of one agent wallet.
    /// @dev Deliberately tolerant — if the agent granted no allowance the sweep is
    ///      skipped rather than reverting, so the pause always lands. Check the
    ///      returned amount and surface a warning in the UI if it is zero.
    function emergencyStop(address agent) external onlyOwner returns (uint256 swept) {
        if (!paused) {
            paused = true;
            emit Paused(msg.sender);
        }
        _requireAgent(agent);

        uint256 held = musd.balanceOf(agent);
        if (held > 0 && musd.allowance(agent, address(this)) >= held) {
            Agent storage a = _agents[agent];
            a.totalRecalled += held;
            totalRecalled += held;
            if (musd.transferFrom(agent, address(this), held)) {
                swept = held;
                emit AgentRecalled(agent, held, musd.balanceOf(agent));
            }
        }
        emit EmergencyStop(agent, swept);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // -------------------------------------------------- receipts (gateway)

    /// @notice Record a settled x402 payment. Callable only by that agent's gateway.
    function recordPayment(
        address agent,
        address payee,
        uint256 amount,
        bytes32 settlementTx,
        string calldata endpoint
    ) external {
        Agent storage a = _requireAgent(agent);
        if (msg.sender != a.gateway) revert NotGateway();

        _payments.push(Payment({
            agent: agent,
            payee: payee,
            amount: amount,
            timestamp: uint64(block.timestamp),
            settlementTx: settlementTx,
            endpoint: endpoint
        }));
        uint256 idx = _payments.length - 1;
        _paymentsByAgent[agent].push(idx);
        paymentCount = _payments.length;

        emit PaymentRecorded(agent, payee, amount, settlementTx, idx);
    }

    /// @notice Record a payment the policy layer refused. Surfacing blocked
    ///         attempts is the point of a budget product, not an afterthought.
    function recordDenial(
        address agent,
        uint256 attempted,
        string calldata endpoint,
        string calldata reason
    ) external {
        Agent storage a = _requireAgent(agent);
        if (msg.sender != a.gateway) revert NotGateway();

        _denials.push(Denial({
            agent: agent,
            attempted: attempted,
            timestamp: uint64(block.timestamp),
            endpoint: endpoint,
            reason: reason
        }));
        uint256 idx = _denials.length - 1;
        _denialsByAgent[agent].push(idx);
        denialCount = _denials.length;

        emit DenialRecorded(agent, attempted, reason, idx);
    }

    // --------------------------------------------------------------- views

    function _today() private view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    function _requireAgent(address agent) private view returns (Agent storage a) {
        a = _agents[agent];
        if (a.registeredAt == 0) revert NotRegistered();
    }

    function agentCount() external view returns (uint256) {
        return _agentList.length;
    }

    function allAgents() external view returns (address[] memory) {
        return _agentList;
    }

    function isRegistered(address agent) external view returns (bool) {
        return _agents[agent].registeredAt != 0;
    }

    /// @notice Raw stored policy for an agent (note: `dayFunded` may be stale
    ///         until the next funding tx rolls the day over).
    function agents(address agent) external view returns (Agent memory) {
        return _agents[agent];
    }

    /// @notice Dashboard-ready snapshot: policy, the UTC-day rollover already
    ///         applied, the agent's live on-chain MUSD balance, and the allowance
    ///         that bounds `emergencyStop`.
    /// @dev Returns a struct rather than a wide tuple — a 10+ value tuple blows
    ///      the EVM stack limit without viaIR, which we deliberately do not enable.
    struct AgentStatus {
        bool     active;
        address  gateway;
        uint128  perCallMax;
        uint128  dailyCap;
        uint128  dayFunded;
        uint256  remainingToday;
        uint256  walletBalance;
        uint256  lifetimeFunded;
        uint256  lifetimeRecalled;
        uint256  recallAllowance;
        uint256  payments;
        uint256  denials;
    }

    function agentStatus(address agent) external view returns (AgentStatus memory s) {
        Agent storage a = _requireAgent(agent);
        uint128 funded = (a.dayIndex == _today()) ? a.dayFunded : 0;

        s.active           = a.active;
        s.gateway          = a.gateway;
        s.perCallMax       = a.perCallMax;
        s.dailyCap         = a.dailyCap;
        s.dayFunded        = funded;
        // Saturating: the cap may have been lowered below today's spend. A revert
        // here would take the whole dashboard down, so clamp to zero instead.
        s.remainingToday   = uint256(a.dailyCap) > uint256(funded)
            ? uint256(a.dailyCap) - uint256(funded)
            : 0;
        s.walletBalance    = musd.balanceOf(agent);
        s.lifetimeFunded   = a.totalFunded;
        s.lifetimeRecalled = a.totalRecalled;
        s.recallAllowance  = musd.allowance(agent, address(this));
        s.payments         = _paymentsByAgent[agent].length;
        s.denials          = _denialsByAgent[agent].length;
    }

    /// @notice Most recent payments, newest first. Bounded so the dashboard can
    ///         page without an unbounded loop.
    function recentPayments(uint256 limit) external view returns (Payment[] memory out) {
        uint256 n = _payments.length;
        uint256 take = limit > n ? n : limit;
        out = new Payment[](take);
        for (uint256 i = 0; i < take; i++) {
            out[i] = _payments[n - 1 - i];
        }
    }

    /// @notice Most recent policy denials, newest first.
    function recentDenials(uint256 limit) external view returns (Denial[] memory out) {
        uint256 n = _denials.length;
        uint256 take = limit > n ? n : limit;
        out = new Denial[](take);
        for (uint256 i = 0; i < take; i++) {
            out[i] = _denials[n - 1 - i];
        }
    }

    function paymentsByAgent(address agent, uint256 limit) external view returns (Payment[] memory out) {
        uint256[] storage idxs = _paymentsByAgent[agent];
        uint256 n = idxs.length;
        uint256 take = limit > n ? n : limit;
        out = new Payment[](take);
        for (uint256 i = 0; i < take; i++) {
            out[i] = _payments[idxs[n - 1 - i]];
        }
    }

    /// @notice Allowance the treasury currently has over an agent's MUSD. The UI
    ///         shows this because it is exactly what bounds `emergencyStop`.
    function recallAllowance(address agent) external view returns (uint256) {
        return musd.allowance(agent, address(this));
    }

    // ------------------------------------------------------------ ownership

    /// @notice Two-step transfer so a typo cannot orphan the treasury.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
