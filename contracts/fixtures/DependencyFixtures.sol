// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ISafeTransferFromFixture {
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
}

/// @notice Source-level fixtures for intraprocedural dependency analysis.
///
/// @dev Each function isolates one dependency shape, and the benign twins are
///      the important half: a `msg.sender` read that reaches nothing, and an
///      `tx.origin` used only for logging. An analysis that flags those has
///      merely relocated the false positive it was built to remove.
contract DependencyFixtures {
    address public authorizedRouter;
    uint256 public counter;
    address public sink;
    mapping(address account => uint256 value) public balances;

    event Seen(address who);

    /// msg.sender guards the condition that guards the assignment.
    function senderGuardsAssignment() external {
        if (msg.sender == authorizedRouter) {
            counter = 1;
        }
    }

    /// msg.sender is read and emitted; it guards nothing.
    function senderOnlyLogged() external {
        emit Seen(msg.sender);
        counter = 1;
    }

    /// The condition and assignment share a function but not a control region.
    function senderConditionDoesNotGuardWrite() external {
        if (msg.sender == authorizedRouter) emit Seen(msg.sender);
        counter = 3;
    }

    /// msg.sender becomes the written value itself.
    function senderBecomesStoredValue() external {
        authorizedRouter = msg.sender;
    }

    /// tx.origin guards an important write.
    function originGuardsAssignment() external {
        require(tx.origin == authorizedRouter, "denied");
        counter = 2;
    }

    /// tx.origin only appears in an event.
    function originOnlyLogged() external {
        emit Seen(tx.origin);
    }

    /// A parameter flows into a low-level call target.
    function parameterControlsCallTarget(address target) external {
        (bool ok, ) = target.call("");
        require(ok, "call failed");
    }

    /// A fixed configuration slot is the call target instead.
    function configuredCallTarget() external {
        (bool ok, ) = sink.call("");
        require(ok, "call failed");
    }

    /// msg.value flows into the forwarded value.
    function valueControlsCallValue(address target) external payable {
        (bool ok, ) = target.call{value: msg.value}("");
        require(ok, "call failed");
    }

    /// A parameter reaches a state write through a local.
    function parameterReachesStorageThroughLocal(uint256 amount) external {
        uint256 doubled = amount * 2;
        counter = doubled;
    }

    /// The caller chooses the mapping key even though the stored value is fixed.
    function senderChoosesMappingKey() external {
        balances[msg.sender] = 1;
    }

    /// A plain assignment to a constant clears the parameter dependency.
    function localTaintIsCleared(address candidate) external {
        address local = candidate;
        local = address(0x1234);
        sink = local;
    }

    /// Four-argument safeTransferFrom keeps `to` at argument 1 and tokenId at 2.
    function fourArgumentSafeTransfer(address token, address from) external {
        ISafeTransferFromFixture(token).safeTransferFrom(from, msg.sender, 7, "");
    }

    /// A local is computed but never reaches anything persistent.
    function localNeverReachesStorage(uint256 amount) external pure returns (uint256) {
        uint256 doubled = amount * 2;
        return doubled;
    }
}
