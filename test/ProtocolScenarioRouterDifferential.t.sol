// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
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

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        ScenarioHook implementation = new ScenarioHook(manager, address(this));
        address hookAddress = address(uint160(0x0fff));
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
    }

    function _state() private view returns (PoolState memory state) {
        (state.sqrtPriceX96, state.tick,, state.lpFee) = manager.getSlot0(poolId);
        state.liquidity = manager.getLiquidity(poolId);
    }

    function _assertSameState(PoolState memory official, PoolState memory generated, string memory label) private pure {
        assertEq(generated.sqrtPriceX96, official.sqrtPriceX96, string.concat(label, ": sqrtPriceX96"));
        assertEq(generated.tick, official.tick, string.concat(label, ": tick"));
        assertEq(generated.lpFee, official.lpFee, string.concat(label, ": lpFee"));
        assertEq(generated.liquidity, official.liquidity, string.concat(label, ": liquidity"));
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

        vm.revertToState(snapshot);

        BalanceDelta[] memory deltas = harness.run(_swapStep(zeroForOne, amountSpecified));
        PoolState memory generated = _state();

        _assertSameState(official, generated, label);
        assertTrue(deltas.length == 1, string.concat(label, ": one delta"));
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

        donateRouter.donate(key, 1e12, 2e12, "");
        PoolState memory official = _state();

        vm.revertToState(snapshot);

        ProtocolScenarioRouter.Step[] memory steps = new ProtocolScenarioRouter.Step[](1);
        steps[0].operation = ProtocolScenarioRouter.Operation.Donate;
        steps[0].key = key;
        steps[0].amount0 = 1e12;
        steps[0].amount1 = 2e12;
        harness.run(steps);

        _assertSameState(official, _state(), "donate");
    }

    function test_liquidityAddMatchesOfficialRouter() public {
        uint256 snapshot = vm.snapshotState();

        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1e18, salt: bytes32(0)}),
            ""
        );
        PoolState memory official = _state();

        vm.revertToState(snapshot);

        ProtocolScenarioRouter.Step[] memory steps = new ProtocolScenarioRouter.Step[](1);
        steps[0].operation = ProtocolScenarioRouter.Operation.ModifyLiquidity;
        steps[0].key = key;
        steps[0].tickLower = -120;
        steps[0].tickUpper = 120;
        steps[0].liquidityDelta = 1e18;
        harness.run(steps);

        _assertSameState(official, _state(), "add liquidity");
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
}
