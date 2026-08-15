// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolDonateTest} from "@uniswap/v4-core/src/test/PoolDonateTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ProtocolScenarioRouter} from "../contracts/fixtures/ProtocolScenarioRouter.sol";
import {ScenarioHook} from "../contracts/fixtures/ScenarioHook.sol";

/// @notice Differential oracle for the generated-scenario harness.
///
/// @dev The harness may only be used as evidence if it moves the pool the same
///      way Uniswap's own test routers do. Each case runs the identical
///      operation twice from an identical pool state — once through the official
///      router, once through the harness — and compares the resulting pool state
///      and returned deltas. Snapshots isolate the two runs so neither observes
///      the other's effect.
contract ProtocolScenarioRouterDifferentialTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    ProtocolScenarioRouter internal harness;
    PoolId internal poolId;

    address internal hookAddress;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        ScenarioHook implementation = new ScenarioHook(manager, address(this));
        hookAddress = address(uint160(0x0fff));
        vm.etch(hookAddress, address(implementation).code);

        (key, poolId) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(hookAddress), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );

        harness = new ProtocolScenarioRouter(manager);
        // The harness settles only in ERC-6909 claims, exactly as the browser
        // overlay will fund it, so no ERC-20 approval is granted here.
        _fundClaims(address(harness), 100 ether);
    }

    function _fundClaims(address owner, uint256 amount) private {
        manager.unlock(abi.encode(owner, amount));
    }

    /// @dev Mints claims by settling real ERC-20 into the manager, which is how a
    ///      test environment obtains claim balance legitimately.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only manager");
        (address owner, uint256 amount) = abi.decode(data, (address, uint256));
        for (uint256 i = 0; i < 2; i++) {
            Currency currency = i == 0 ? currency0 : currency1;
            manager.sync(currency);
            MockERC20Like(Currency.unwrap(currency)).transfer(address(manager), amount);
            manager.settle();
            manager.mint(owner, currency.toId(), amount);
        }
        return "";
    }

    struct PoolState {
        uint160 sqrtPriceX96;
        int24 tick;
        uint24 lpFee;
        uint128 liquidity;
        uint256 feeGrowthGlobal0;
        uint256 feeGrowthGlobal1;
        uint256 managerBalance0;
        uint256 managerBalance1;
        /// @dev Hashed so an ordered comparison covers topics and data without
        ///      hand-listing every field of every event.
        bytes32 poolLogDigest;
        /// @dev Ordered hook callbacks observed for this operation.
        bytes32 hookCallDigest;
    }

    function _state() private view returns (PoolState memory state) {
        (state.sqrtPriceX96, state.tick,, state.lpFee) = manager.getSlot0(poolId);
        state.liquidity = manager.getLiquidity(poolId);
        (state.feeGrowthGlobal0, state.feeGrowthGlobal1) = manager.getFeeGrowthGlobals(poolId);
        state.managerBalance0 = MockERC20Like(Currency.unwrap(currency0)).balanceOf(address(manager));
        state.managerBalance1 = MockERC20Like(Currency.unwrap(currency1)).balanceOf(address(manager));
    }

    /// @notice Digest of every PoolManager log naming this pool, in order.
    /// @dev Comparing a digest rather than field-by-field means a future event
    ///      field cannot silently escape the differential. The indexed `sender`
    ///      topic is normalized away because it is the one field that must
    ///      differ: the whole point is that a different contract drove the pool.
    ///      Everything else — amounts, price, liquidity, tick, fee — is compared.
    function _poolLogDigest() private returns (bytes32 digest) {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(manager)) continue;
            if (logs[i].topics.length < 2 || logs[i].topics[1] != PoolId.unwrap(poolId)) continue;
            bytes32[] memory topics = logs[i].topics;
            if (topics.length > 2) topics[2] = bytes32(0);
            digest = keccak256(abi.encode(digest, topics, logs[i].data));
        }
    }

    /// @notice Ordered digest of the hook callbacks the operation triggered.
    /// @dev Built from recorded account accesses rather than from hook counters,
    ///      so the comparison covers the order the callbacks fired in, not just
    ///      how many times each one did.
    function _hookCallDigest() private returns (bytes32 digest) {
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        for (uint256 i = 0; i < accesses.length; i++) {
            if (accesses[i].account != hookAddress) continue;
            if (accesses[i].kind != VmSafe.AccountAccessKind.Call) continue;
            if (accesses[i].data.length < 4) continue;
            bytes4 selector = bytes4(accesses[i].data);
            digest = keccak256(abi.encode(digest, selector));
        }
    }

    function _assertSameState(PoolState memory official, PoolState memory generated, string memory label)
        private
        pure
    {
        assertEq(generated.sqrtPriceX96, official.sqrtPriceX96, string.concat(label, ": sqrtPriceX96"));
        assertEq(generated.tick, official.tick, string.concat(label, ": tick"));
        assertEq(generated.lpFee, official.lpFee, string.concat(label, ": lpFee"));
        assertEq(generated.liquidity, official.liquidity, string.concat(label, ": liquidity"));
        assertEq(generated.feeGrowthGlobal0, official.feeGrowthGlobal0, string.concat(label, ": feeGrowthGlobal0"));
        assertEq(generated.feeGrowthGlobal1, official.feeGrowthGlobal1, string.concat(label, ": feeGrowthGlobal1"));
        assertEq(generated.poolLogDigest, official.poolLogDigest, string.concat(label, ": pool event stream"));
        assertEq(generated.hookCallDigest, official.hookCallDigest, string.concat(label, ": hook callback sequence"));
    }

    function _swapStep(bool zeroForOne, int256 amountSpecified)
        private
        view
        returns (ProtocolScenarioRouter.Step[] memory steps)
    {
        steps = new ProtocolScenarioRouter.Step[](1);
        steps[0].operation = ProtocolScenarioRouter.Operation.Swap;
        steps[0].key = key;
        steps[0].zeroForOne = zeroForOne;
        steps[0].amountSpecified = amountSpecified;
        steps[0].sqrtPriceLimitX96 =
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    function _runSwapDifferential(bool zeroForOne, int256 amountSpecified, string memory label) private {
        uint256 snapshot = vm.snapshotState();
        uint256 snapshotBalance0 = MockERC20Like(Currency.unwrap(currency0)).balanceOf(address(manager));
        uint256 snapshotBalance1 = MockERC20Like(Currency.unwrap(currency1)).balanceOf(address(manager));
        uint256 snapshotClaims0 = manager.balanceOf(address(harness), currency0.toId());
        uint256 snapshotClaims1 = manager.balanceOf(address(harness), currency1.toId());
        vm.recordLogs();
        vm.startStateDiffRecording();
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        PoolState memory official = _state();
        official.poolLogDigest = _poolLogDigest();
        official.hookCallDigest = _hookCallDigest();
        int256 officialDelta0 = _managerDelta(snapshotBalance0, official.managerBalance0);
        int256 officialDelta1 = _managerDelta(snapshotBalance1, official.managerBalance1);

        vm.revertToState(snapshot);

        vm.recordLogs();
        vm.startStateDiffRecording();
        BalanceDelta[] memory deltas = harness.run(_swapStep(zeroForOne, amountSpecified));
        PoolState memory generated = _state();
        generated.poolLogDigest = _poolLogDigest();
        generated.hookCallDigest = _hookCallDigest();

        _assertSameState(official, generated, label);
        assertTrue(deltas.length == 1, string.concat(label, ": one delta"));

        // The two routes settle on different rails, so the differential compares
        // them across rails rather than pretending they are the same.
        //
        // The official router moves the manager's ERC-20 balance; the harness
        // burns and mints ERC-6909 claims and must leave ERC-20 untouched. What
        // must agree is the amount the pool itself gained or lost.
        int256 claimsDelta0 = _managerDelta(snapshotClaims0, manager.balanceOf(address(harness), currency0.toId()));
        int256 claimsDelta1 = _managerDelta(snapshotClaims1, manager.balanceOf(address(harness), currency1.toId()));

        assertEq(
            int256(deltas[0].amount0()), claimsDelta0, string.concat(label, ": returned delta0 matches claim movement")
        );
        assertEq(
            int256(deltas[0].amount1()), claimsDelta1, string.concat(label, ": returned delta1 matches claim movement")
        );
        assertEq(
            _managerDelta(snapshotBalance0, generated.managerBalance0),
            int256(0),
            string.concat(label, ": harness left the manager's ERC-20 balance0 untouched")
        );
        assertEq(
            _managerDelta(snapshotBalance1, generated.managerBalance1),
            int256(0),
            string.concat(label, ": harness left the manager's ERC-20 balance1 untouched")
        );
        // What the pool gained on one rail, it gained on the other.
        assertEq(-claimsDelta0, officialDelta0, string.concat(label, ": pool amount0 agrees across rails"));
        assertEq(-claimsDelta1, officialDelta1, string.concat(label, ": pool amount1 agrees across rails"));
    }

    function _managerDelta(uint256 before, uint256 amountAfter) private pure returns (int256) {
        return int256(amountAfter) - int256(before);
    }

    function test_exactInputZeroForOneMatchesOfficialRouter() public {
        _runSwapDifferential(true, -1e15, "exact-input 0->1");
    }

    function test_exactInputOneForZeroMatchesOfficialRouter() public {
        _runSwapDifferential(false, -1e15, "exact-input 1->0");
    }

    function test_exactOutputZeroForOneMatchesOfficialRouter() public {
        _runSwapDifferential(true, 1e15, "exact-output 0->1");
    }

    function test_exactOutputOneForZeroMatchesOfficialRouter() public {
        _runSwapDifferential(false, 1e15, "exact-output 1->0");
    }

    function test_donationMatchesOfficialRouter() public {
        uint256 snapshot = vm.snapshotState();

        vm.recordLogs();
        vm.startStateDiffRecording();
        donateRouter.donate(key, 1e12, 2e12, "");
        PoolState memory official = _state();
        official.poolLogDigest = _poolLogDigest();
        official.hookCallDigest = _hookCallDigest();

        vm.revertToState(snapshot);

        ProtocolScenarioRouter.Step[] memory steps = new ProtocolScenarioRouter.Step[](1);
        steps[0].operation = ProtocolScenarioRouter.Operation.Donate;
        steps[0].key = key;
        steps[0].amount0 = 1e12;
        steps[0].amount1 = 2e12;

        vm.recordLogs();
        vm.startStateDiffRecording();
        harness.run(steps);
        PoolState memory generated = _state();
        generated.poolLogDigest = _poolLogDigest();
        generated.hookCallDigest = _hookCallDigest();

        _assertSameState(official, generated, "donate");
        assertTrue(official.poolLogDigest != bytes32(0), "donate: the differential compared a real event stream");
    }

    function test_liquidityAddMatchesOfficialRouter() public {
        uint256 snapshot = vm.snapshotState();

        vm.recordLogs();
        vm.startStateDiffRecording();
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e18, salt: bytes32(0)}),
            ""
        );
        PoolState memory official = _state();
        official.poolLogDigest = _poolLogDigest();
        official.hookCallDigest = _hookCallDigest();

        vm.revertToState(snapshot);

        ProtocolScenarioRouter.Step[] memory steps = new ProtocolScenarioRouter.Step[](1);
        steps[0].operation = ProtocolScenarioRouter.Operation.ModifyLiquidity;
        steps[0].key = key;
        steps[0].tickLower = -120;
        steps[0].tickUpper = 120;
        steps[0].liquidityDelta = 1e18;

        vm.recordLogs();
        vm.startStateDiffRecording();
        harness.run(steps);
        PoolState memory generated = _state();
        generated.poolLogDigest = _poolLogDigest();
        generated.hookCallDigest = _hookCallDigest();

        _assertSameState(official, generated, "add liquidity");
        assertTrue(official.poolLogDigest != bytes32(0), "add liquidity: the differential compared a real event stream");
        assertTrue(official.hookCallDigest != bytes32(0), "add liquidity: the differential compared real hook callbacks");
    }

    /// @dev Adding then removing the same liquidity in one unlock must leave the
    ///      pool where it started; a sequence that only balances at the end would
    ///      hide an intermediate unsettled currency.
    function test_addThenRemoveInOneSequenceReturnsToStart() public {
        PoolState memory before = _state();

        ProtocolScenarioRouter.Step[] memory steps = new ProtocolScenarioRouter.Step[](2);
        steps[0].operation = ProtocolScenarioRouter.Operation.ModifyLiquidity;
        steps[0].key = key;
        steps[0].tickLower = -120;
        steps[0].tickUpper = 120;
        steps[0].liquidityDelta = 1e18;
        // Assigning steps[1] = steps[0] would copy the memory pointer, so both
        // entries would mutate together. Build the second step explicitly.
        steps[1].operation = ProtocolScenarioRouter.Operation.ModifyLiquidity;
        steps[1].key = key;
        steps[1].tickLower = -120;
        steps[1].tickUpper = 120;
        steps[1].liquidityDelta = -1e18;

        harness.run(steps);

        assertEq(_state().liquidity, before.liquidity, "liquidity returned to start");
    }

    /// @dev Ground truth for the browser overlay: mint a known claim balance and
    ///      prove it lands at the slot the TypeScript derivation computes, so the
    ///      overlay cannot silently write to a slot nothing reads.
    function test_erc6909ClaimSlotDerivationMatchesStorage() public {
        address owner = address(0xBEEF);
        uint256 amount = 123_456_789;
        _fundClaims(owner, amount);

        uint256 id = uint256(uint160(Currency.unwrap(currency0)));
        // balanceOf lives at slot 4 in the pinned PoolManager build.
        bytes32 ownerBase = keccak256(abi.encode(owner, uint256(4)));
        bytes32 slot = keccak256(abi.encode(id, ownerBase));

        assertEq(uint256(vm.load(address(manager), slot)), amount, "claim balance slot");
        assertEq(manager.balanceOf(owner, id), amount, "accessor agrees with raw slot");

        emit log_named_bytes32("currency0 claim slot for 0xBEEF", slot);
        emit log_named_uint("currency0 id", id);
    }

    function test_harnessRejectsUnlockCallbackFromNonManager() public {
        vm.expectRevert();
        harness.unlockCallback("");
    }
}

interface MockERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}
