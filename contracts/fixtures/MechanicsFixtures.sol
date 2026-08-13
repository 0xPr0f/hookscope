// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Small deterministic contracts used to compare browser EVM results
/// with Foundry. They model observable DeFi mechanics, not production tokens.

contract BaselineAccountingFixture {
    mapping(address account => uint256 amount) public balanceOf;

    function credit(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }
}

contract DirectionalExecutionFixture {
    error DirectionUnavailable();

    bool public zeroForOneUnavailable;
    uint256 public lastAmount;

    function configure(bool unavailable) external {
        zeroForOneUnavailable = unavailable;
    }

    function execute(bool zeroForOne, uint256 amount) external returns (uint256 output) {
        if (zeroForOne && zeroForOneUnavailable) revert DirectionUnavailable();
        lastAmount = amount;
        return zeroForOne ? amount * 2 : amount * 3;
    }
}

contract CallerVariableFixture {
    mapping(address caller => uint256 multiplier) public multiplierOf;
    uint256 public lastOutput;

    function setMultiplier(address caller, uint256 multiplier) external {
        multiplierOf[caller] = multiplier;
    }

    function quote(uint256 amount) external returns (uint256 output) {
        uint256 multiplier = multiplierOf[msg.sender];
        output = amount * (multiplier == 0 ? 1 : multiplier);
        lastOutput = output;
    }
}

contract ConfigurableDelegateFixture {
    address public implementation;

    function configureImplementation(address next) external {
        implementation = next;
    }

    fallback(bytes calldata input) external payable returns (bytes memory output) {
        (bool ok, bytes memory data) = implementation.delegatecall(input);
        if (!ok) assembly ("memory-safe") {
            revert(add(data, 0x20), mload(data))
        }
        return data;
    }
}

contract MutableImplementationFixture {
    // EIP-1967 implementation slot.
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address public controller;

    constructor() {
        controller = msg.sender;
    }

    function implementation() public view returns (address value) {
        assembly ("memory-safe") {
            value := sload(IMPLEMENTATION_SLOT)
        }
    }

    function setImplementation(address next) external {
        require(msg.sender == controller, "controller");
        assembly ("memory-safe") {
            sstore(IMPLEMENTATION_SLOT, next)
        }
    }

    fallback(bytes calldata input) external payable returns (bytes memory output) {
        address target = implementation();
        (bool ok, bytes memory data) = target.delegatecall(input);
        if (!ok) assembly ("memory-safe") {
            revert(add(data, 0x20), mload(data))
        }
        return data;
    }
}

contract VariableFeeFixture {
    uint24 public baseFee;
    uint24 public largeAmountFee;
    uint256 public threshold;

    function configure(uint24 normalFee, uint24 largeFee, uint256 amountThreshold) external {
        baseFee = normalFee;
        largeAmountFee = largeFee;
        threshold = amountThreshold;
    }

    function feeFor(uint256 amount) external view returns (uint24) {
        return amount >= threshold ? largeAmountFee : baseFee;
    }
}

contract ParticipantListFixture {
    mapping(address participant => bool enabled) public enabled;
    uint256 public completed;

    function setParticipant(address participant, bool value) external {
        enabled[participant] = value;
    }

    function executeFor(address participant) external {
        require(enabled[participant], "participant");
        completed++;
    }
}

contract NestedCallFixture {
    address public target;
    uint256 public callbackCount;

    function configure(address next) external {
        target = next;
    }

    function execute(bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory output) = target.call(data);
        require(ok, "nested call");
        callbackCount++;
        return output;
    }
}

contract TransientSequenceFixture {
    error SequenceNotStarted();

    function begin() external {
        assembly ("memory-safe") {
            tstore(0, 1)
        }
    }

    function finish() external view returns (bool) {
        uint256 active;
        assembly ("memory-safe") {
            active := tload(0)
        }
        if (active != 1) revert SequenceNotStarted();
        return true;
    }
}

contract LiquidityControlFixture {
    address public controller;
    mapping(address asset => uint256 amount) public managedLiquidity;

    constructor() {
        controller = msg.sender;
    }

    function record(address asset, uint256 amount) external {
        managedLiquidity[asset] += amount;
    }

    function withdrawManaged(address asset, uint256 amount) external {
        require(msg.sender == controller, "controller");
        managedLiquidity[asset] -= amount;
    }
}
