// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ---------------------------------------------------------------------------
// MockMUSD — LOCAL TESTING ONLY. Never deploy this to Mezo testnet.
//
// Real testnet MUSD is 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 ("Mezo USD",
// 18 decimals) and is minted by borrowing against testnet BTC, not by a faucet.
// This mock exists so the policy logic can be proved under `npx hardhat test`
// before spending any testnet BTC on gas.
//
// Matches MUSD's observable shape: 18 decimals, name "Mezo USD", symbol "MUSD".
// ---------------------------------------------------------------------------

contract MockMUSD {
    string public constant name = "Mezo USD";
    string public constant symbol = "MUSD";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice Test helper — the real token has no public mint.
    function faucet(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "MockMUSD: allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        require(balanceOf[from] >= amount, "MockMUSD: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
