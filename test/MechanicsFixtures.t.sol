// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {
    BaselineAccountingFixture,
    DirectionalExecutionFixture,
    CallerVariableFixture,
    ConfigurableDelegateFixture,
    MutableImplementationFixture,
    VariableFeeFixture,
    ParticipantListFixture,
    NestedCallFixture,
    TransientSequenceFixture,
    LiquidityControlFixture
} from "../contracts/fixtures/MechanicsFixtures.sol";

contract DelegateCounter {
    uint256 public value;

    function setValue(uint256 next) external returns (uint256) {
        value = next;
        return next;
    }
}

contract MechanicsFixturesTest is Test {
    function test_baselineAccountingIsDeterministic() public {
        BaselineAccountingFixture fixture = new BaselineAccountingFixture();
        fixture.credit(address(this), 7);
        assertEq(fixture.balanceOf(address(this)), 7);
    }

    function test_directionalExecutionProducesDistinctOutcomes() public {
        DirectionalExecutionFixture fixture = new DirectionalExecutionFixture();
        assertEq(fixture.execute(true, 4), 8);
        assertEq(fixture.execute(false, 4), 12);
        fixture.configure(true);
        vm.expectRevert(DirectionalExecutionFixture.DirectionUnavailable.selector);
        fixture.execute(true, 4);
    }

    function test_callerVariableExecutionProducesObservableState() public {
        CallerVariableFixture fixture = new CallerVariableFixture();
        address participant = makeAddr("participant");
        fixture.setMultiplier(participant, 4);
        vm.prank(participant);
        assertEq(fixture.quote(5), 20);
        assertEq(fixture.lastOutput(), 20);
    }

    function test_delegateAndImplementationFixturesChangeTheirOwnStorage() public {
        DelegateCounter implementation = new DelegateCounter();
        ConfigurableDelegateFixture delegateFixture = new ConfigurableDelegateFixture();
        delegateFixture.configureImplementation(address(implementation));
        (bool ok,) = address(delegateFixture).call(abi.encodeCall(DelegateCounter.setValue, (19)));
        assertTrue(ok);
        assertEq(uint256(uint160(delegateFixture.implementation())), 19);

        MutableImplementationFixture proxyFixture = new MutableImplementationFixture();
        proxyFixture.setImplementation(address(implementation));
        assertEq(proxyFixture.implementation(), address(implementation));
    }

    function test_feeParticipantNestedSequenceAndLiquidityMechanics() public {
        VariableFeeFixture fees = new VariableFeeFixture();
        fees.configure(3000, 10_000, 100 ether);
        assertEq(fees.feeFor(1 ether), 3000);
        assertEq(fees.feeFor(100 ether), 10_000);

        ParticipantListFixture participants = new ParticipantListFixture();
        participants.setParticipant(address(this), true);
        participants.executeFor(address(this));
        assertEq(participants.completed(), 1);

        DelegateCounter target = new DelegateCounter();
        NestedCallFixture nested = new NestedCallFixture();
        nested.configure(address(target));
        nested.execute(abi.encodeCall(DelegateCounter.setValue, (23)));
        assertEq(nested.callbackCount(), 1);
        assertEq(target.value(), 23);

        TransientSequenceFixture sequence = new TransientSequenceFixture();
        sequence.begin();
        assertTrue(sequence.finish());

        LiquidityControlFixture liquidity = new LiquidityControlFixture();
        liquidity.record(address(1), 50);
        liquidity.withdrawManaged(address(1), 20);
        assertEq(liquidity.managedLiquidity(address(1)), 30);
    }
}
