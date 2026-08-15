// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ConfigurableScenarioToken
/// @notice A deterministic ERC-20 whose awkward behaviors can be switched on
///         individually, for testing the ERC-20 settlement lane.
///
/// @dev Every behavior here exists because it is invisible to a claims-only
///      harness: a fee skimmed during transfer, a rejection that depends on who
///      is receiving, a rejection that depends on who is calling, and an
///      approval that silently refuses. Each is a property of the token, not of
///      the pool or the hook, so the acceptance criterion for the ERC-20 lane is
///      that it reports them as concrete token-path observations while the
///      claims baseline continues to pass.
///
///      Deliberately minimal and self-contained: a fixture that inherited a real
///      token library would make it harder to see exactly which rule fired.
contract ConfigurableScenarioToken {
    string public name = "Scenario";
    string public symbol = "SCN";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Basis points skimmed from every transfer and transferFrom.
    uint256 public transferFeeBps;
    /// @notice Recipients that `transferFrom` refuses to pay, i.e. a sell block.
    mapping(address => bool) public transferFromToBlocked;
    /// @notice Callers that `transferFrom` refuses to serve.
    mapping(address => bool) public spenderBlocked;
    /// @notice Owners for whom `approve` returns false without recording anything.
    mapping(address => bool) public approvalBlocked;
    /// @notice Below this amount a transfer is refused.
    uint256 public minimumTransfer;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setTransferFeeBps(uint256 bps) external {
        require(bps <= 10_000, "fee too high");
        transferFeeBps = bps;
    }

    function setTransferFromToBlocked(address to, bool blocked) external {
        transferFromToBlocked[to] = blocked;
    }

    function setSpenderBlocked(address spender, bool blocked) external {
        spenderBlocked[spender] = blocked;
    }

    function setApprovalBlocked(address owner, bool blocked) external {
        approvalBlocked[owner] = blocked;
    }

    function setMinimumTransfer(uint256 amount) external {
        minimumTransfer = amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        // Returning false rather than reverting is the harder case: a caller
        // that ignores the return value would proceed on an allowance it never got.
        if (approvalBlocked[msg.sender]) return false;
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!spenderBlocked[msg.sender], "spender blocked");
        require(!transferFromToBlocked[to], "recipient blocked");
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    /// @dev The fee is skimmed from the delivered amount, so the recipient
    ///      receives less than was requested. That gap is the observation the
    ///      ERC-20 lane exists to surface.
    function _move(address from, address to, uint256 amount) private {
        require(amount >= minimumTransfer, "below minimum");
        require(balanceOf[from] >= amount, "insufficient balance");
        uint256 fee = (amount * transferFeeBps) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        if (fee > 0) balanceOf[address(this)] += fee;
        emit Transfer(from, to, amount - fee);
    }
}
