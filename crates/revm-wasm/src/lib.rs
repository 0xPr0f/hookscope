//! Small, evidence-only revm bridge for Dedicated Web Workers.
//! It deliberately delegates all EVM semantics to revm and only serializes
//! execution observations for the TypeScript evidence normalizer.

#[cfg(feature = "libafl-fuzz")]
use libafl::{
    corpus::InMemoryCorpus,
    events::SimpleEventManager,
    executors::{ExitKind, InProcessExecutor},
    feedbacks::{CrashFeedback, MapFeedbackMetadata, MaxMapFeedback},
    inputs::{BytesInput, HasTargetBytes},
    monitors::SimpleMonitor,
    mutators::{havoc_mutations, HavocScheduledMutator},
    observers::StdMapObserver,
    schedulers::QueueScheduler,
    stages::{RetryCountRestartHelper, StdMutationalStage},
    state::{HasExecutions, HasMaxSize, StdState},
    Evaluator, Fuzzer, StdFuzzer,
};
#[cfg(feature = "libafl-fuzz")]
use libafl_bolts::{
    nonzero, rands::StdRand, serdeany::RegistryBuilder, tuples::tuple_list, AsSlice,
};
use revm::{
    context::{Context, TxEnv},
    database::{BenchmarkDB, BENCH_CALLER, BENCH_TARGET},
    inspector::{InspectEvm, Inspector},
    interpreter::{
        interpreter_types::{InputsTr, Jumps},
        CallInputs, CallOutcome, Interpreter, InterpreterTypes,
    },
    primitives::{Address, Bytes, Log, TxKind, U256},
    state::{
        bytecode::{opcode, Bytecode, OpCode},
        EvmState,
    },
    MainBuilder, MainContext,
};
use serde::Serialize;
use std::collections::{BTreeSet, HashSet};
#[cfg(feature = "libafl-fuzz")]
use std::sync::Once;
use wasm_bindgen::prelude::*;

mod fork;

const MAX_STEP_EVENTS: usize = 50_000;
#[cfg(feature = "libafl-fuzz")]
const FUZZ_COVERAGE_MAP_SIZE: usize = 65_536;
#[cfg(feature = "libafl-fuzz")]
const MAX_FUZZ_INPUT_BYTES: usize = 512;
#[cfg(feature = "libafl-fuzz")]
static LIBAFL_REGISTRY: Once = Once::new();

// LibAFL's no-default-features Wasm build delegates monotonic time to the host.
// This symbol follows the upstream baby_fuzzer_wasm integration contract.
#[cfg(all(feature = "libafl-fuzz", target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn external_current_millis() -> u64 {
    web_sys::window()
        .and_then(|window| window.performance())
        .map(|performance| performance.now() as u64)
        .unwrap_or(0)
}

#[cfg(all(feature = "libafl-fuzz", not(target_arch = "wasm32")))]
#[no_mangle]
pub extern "C" fn external_current_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepEvidence {
    address: String,
    pc: usize,
    opcode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallEvidence {
    caller: String,
    target: String,
    bytecode_address: String,
    scheme: String,
    value: String,
    input_length: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageDiff {
    address: String,
    slot: String,
    before: String,
    after: String,
}

#[derive(Debug)]
struct EvidenceInspector {
    steps: Vec<StepEvidence>,
    storage_operations: Vec<StepEvidence>,
    calls: Vec<CallEvidence>,
    log_count: usize,
    selfdestructs: Vec<(String, String, String)>,
    truncated: bool,
    step_limit: usize,
}

impl Default for EvidenceInspector {
    fn default() -> Self {
        Self::with_step_limit(MAX_STEP_EVENTS)
    }
}

impl EvidenceInspector {
    fn with_step_limit(step_limit: usize) -> Self {
        Self {
            steps: Vec::new(),
            storage_operations: Vec::new(),
            calls: Vec::new(),
            log_count: 0,
            selfdestructs: Vec::new(),
            truncated: false,
            step_limit: step_limit.clamp(64, MAX_STEP_EVENTS),
        }
    }
}

impl<CTX, INTR> Inspector<CTX, INTR> for EvidenceInspector
where
    INTR: InterpreterTypes,
    INTR::Bytecode: Jumps,
{
    fn step(&mut self, interp: &mut Interpreter<INTR>, _context: &mut CTX) {
        let opcode_byte = interp.bytecode.opcode();
        let bytecode_address = interp
            .input
            .bytecode_address()
            .copied()
            .unwrap_or_else(|| interp.input.target_address());
        let event = StepEvidence {
            address: format!("{bytecode_address:?}"),
            pc: interp.bytecode.pc(),
            opcode: OpCode::new(opcode_byte)
                .map(|value| format!("{value}"))
                .unwrap_or_else(|| format!("UNKNOWN_0x{opcode_byte:02x}")),
        };
        if matches!(
            opcode_byte,
            opcode::SLOAD | opcode::SSTORE | opcode::TLOAD | opcode::TSTORE
        ) {
            self.storage_operations.push(StepEvidence {
                address: event.address.clone(),
                pc: event.pc,
                opcode: event.opcode.clone(),
            });
        }
        if self.steps.len() < self.step_limit {
            self.steps.push(event);
        } else {
            self.truncated = true;
        }
    }

    fn call(&mut self, _context: &mut CTX, inputs: &mut CallInputs) -> Option<CallOutcome> {
        self.calls.push(CallEvidence {
            caller: format!("{:?}", inputs.caller),
            target: format!("{:?}", inputs.target_address),
            bytecode_address: format!("{:?}", inputs.bytecode_address),
            scheme: format!("{:?}", inputs.scheme),
            value: inputs.transfer_value().unwrap_or(U256::ZERO).to_string(),
            input_length: inputs.input.len(),
        });
        None
    }

    fn log(&mut self, _context: &mut CTX, _log: Log) {
        self.log_count += 1;
    }

    fn selfdestruct(&mut self, contract: Address, target: Address, value: U256) {
        self.selfdestructs.push((
            format!("{contract:?}"),
            format!("{target:?}"),
            value.to_string(),
        ));
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionProof {
    engine: &'static str,
    success: bool,
    gas_used: u64,
    output: String,
    steps: Vec<StepEvidence>,
    storage_operations: Vec<StepEvidence>,
    calls: Vec<CallEvidence>,
    storage_diffs: Vec<StorageDiff>,
    log_count: usize,
    selfdestructs: Vec<(String, String, String)>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExplorationWitness {
    calldata: String,
    success: bool,
    gas_used: u64,
    new_edges: usize,
    output: String,
    storage_diffs: Vec<StorageDiff>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExplorationSummary {
    engine: &'static str,
    strategy: &'static str,
    executions: usize,
    coverage_edges: usize,
    unique_outcomes: usize,
    witnesses: Vec<ExplorationWitness>,
}

fn decode_hex(value: &str, field: &str) -> Result<Vec<u8>, String> {
    hex::decode(value.strip_prefix("0x").unwrap_or(value))
        .map_err(|error| format!("{field} is not valid hex: {error}"))
}

fn state_diffs(state: &EvmState) -> Vec<StorageDiff> {
    let mut diffs = Vec::new();
    for (address, account) in state {
        for (slot, value) in &account.storage {
            if value.is_changed() {
                diffs.push(StorageDiff {
                    address: format!("{address:?}"),
                    slot: format!("0x{slot:064x}"),
                    before: format!("0x{:064x}", value.original_value),
                    after: format!("0x{:064x}", value.present_value),
                });
            }
        }
    }
    diffs.sort_by(|left, right| {
        (left.address.as_str(), left.slot.as_str())
            .cmp(&(right.address.as_str(), right.slot.as_str()))
    });
    diffs
}

fn execute_decoded(
    bytecode: &Bytecode,
    input: &[u8],
    step_limit: usize,
) -> Result<ExecutionProof, String> {
    let context = Context::mainnet().with_db(BenchmarkDB::new_bytecode(bytecode.clone()));
    let mut inspector = EvidenceInspector::with_step_limit(step_limit);
    let transaction = TxEnv::builder()
        .caller(BENCH_CALLER)
        .kind(TxKind::Call(BENCH_TARGET))
        .data(Bytes::copy_from_slice(input))
        .gas_limit(2_000_000)
        .build()
        .map_err(|error| format!("invalid transaction: {error}"))?;
    let result_and_state = {
        let mut evm = context.build_mainnet_with_inspector(&mut inspector);
        evm.inspect_tx(transaction)
            .map_err(|error| format!("revm execution failed: {error}"))?
    };
    let result = result_and_state.result;
    Ok(ExecutionProof {
        engine: "revm/36.0.0",
        success: result.is_success(),
        gas_used: result.gas_used(),
        output: result
            .output()
            .map(|bytes| format!("0x{}", hex::encode(bytes)))
            .unwrap_or_else(|| "0x".to_owned()),
        steps: inspector.steps,
        storage_operations: inspector.storage_operations,
        calls: inspector.calls,
        storage_diffs: state_diffs(&result_and_state.state),
        log_count: inspector.log_count,
        selfdestructs: inspector.selfdestructs,
        truncated: inspector.truncated,
    })
}

fn execute(runtime_bytecode: &str, calldata: &str) -> Result<ExecutionProof, String> {
    let runtime = decode_hex(runtime_bytecode, "runtimeBytecode")?;
    let input = decode_hex(calldata, "calldata")?;
    execute_decoded(
        &Bytecode::new_raw(Bytes::from(runtime)),
        &input,
        MAX_STEP_EVENTS,
    )
}

fn exploration_calldata(index: usize, state: &mut u64) -> String {
    let value = match index {
        0 => 0,
        1 => 1,
        2 => u64::MAX,
        _ => {
            *state ^= *state << 13;
            *state ^= *state >> 7;
            *state ^= *state << 17;
            *state
        }
    };
    format!("0x{value:064x}")
}

fn outcome_fingerprint(proof: &ExecutionProof) -> String {
    let mut storage = proof
        .storage_diffs
        .iter()
        .map(|diff| format!("{}:{}:{}", diff.address, diff.slot, diff.after))
        .collect::<Vec<_>>();
    storage.sort();
    format!("{}|{}|{}", proof.success, proof.output, storage.join("|"))
}

fn explore(runtime_bytecode: &str, max_executions: usize) -> Result<ExplorationSummary, String> {
    let execution_limit = max_executions.clamp(1, 30_000);
    let runtime = decode_hex(runtime_bytecode, "runtimeBytecode")?;
    let bytecode = Bytecode::new_raw(Bytes::from(runtime));
    let mut random_state = 0x484f_4f4b_5343_4f50_u64;
    let mut covered_edges = HashSet::<(usize, usize)>::new();
    let mut outcomes = BTreeSet::<String>::new();
    let mut witnesses = Vec::new();

    for index in 0..execution_limit {
        let calldata = exploration_calldata(index, &mut random_state);
        let input = decode_hex(&calldata, "calldata")?;
        let proof = execute_decoded(&bytecode, &input, MAX_STEP_EVENTS)?;
        let mut previous = usize::MAX;
        let mut new_edges = 0;
        for step in &proof.steps {
            if covered_edges.insert((previous, step.pc)) {
                new_edges += 1;
            }
            previous = step.pc;
        }
        let new_outcome = outcomes.insert(outcome_fingerprint(&proof));
        if (new_edges > 0 || new_outcome) && witnesses.len() < 128 {
            witnesses.push(ExplorationWitness {
                calldata,
                success: proof.success,
                gas_used: proof.gas_used,
                new_edges,
                output: proof.output.clone(),
                storage_diffs: proof.storage_diffs,
            });
        }
    }

    Ok(ExplorationSummary {
        engine: "revm/36.0.0",
        strategy: "deterministic-edge-corpus/0.1.0",
        executions: execution_limit,
        coverage_edges: covered_edges.len(),
        unique_outcomes: outcomes.len(),
        witnesses,
    })
}

#[cfg(feature = "libafl-fuzz")]
fn register_libafl_types() {
    LIBAFL_REGISTRY.call_once(|| unsafe {
        // LibAFL cannot auto-register SerdeAny types in the no-default-features
        // browser build. These are the same explicit registrations used by its
        // upstream Wasm example.
        RegistryBuilder::register::<MapFeedbackMetadata<u8>>();
        RegistryBuilder::register::<RetryCountRestartHelper>();
        RegistryBuilder::register::<ExitKind>();
    });
}

#[cfg(feature = "libafl-fuzz")]
fn coverage_index(previous: usize, current: usize) -> usize {
    previous
        .wrapping_mul(0x9e37_79b1)
        .rotate_left(7)
        .wrapping_add(current)
        % FUZZ_COVERAGE_MAP_SIZE
}

#[cfg(feature = "libafl-fuzz")]
fn libafl_explore(
    runtime_bytecode: &str,
    max_executions: usize,
    seed: u64,
    exchange_seeds: &[Vec<u8>],
) -> Result<ExplorationSummary, String> {
    register_libafl_types();
    let execution_limit = max_executions.clamp(1, 30_000);
    let runtime = decode_hex(runtime_bytecode, "runtimeBytecode")?;
    let bytecode = Bytecode::new_raw(Bytes::from(runtime));
    let mut signals = vec![0u8; FUZZ_COVERAGE_MAP_SIZE];
    let signals_ptr = signals.as_mut_ptr();
    let mut covered_edges = HashSet::<(usize, usize)>::new();
    let mut outcomes = BTreeSet::<String>::new();
    let mut witnesses = Vec::<ExplorationWitness>::new();

    let executions = {
        let mut harness = |input: &BytesInput| {
            // The observer and harness share the map exactly as in LibAFL's
            // official Wasm example. A worker owns one instance, so there is no
            // cross-thread access to this pointer.
            unsafe { std::ptr::write_bytes(signals_ptr, 0, FUZZ_COVERAGE_MAP_SIZE) };
            let bytes = input.target_bytes();
            let proof = execute_decoded(&bytecode, bytes.as_slice(), MAX_STEP_EVENTS)
                .expect("validated runtime and bounded calldata must execute");
            let mut previous = usize::MAX;
            let mut new_edges = 0usize;
            for step in &proof.steps {
                let edge = (previous, step.pc);
                let index = coverage_index(previous, step.pc);
                unsafe {
                    let counter = signals_ptr.add(index);
                    *counter = (*counter).saturating_add(1);
                }
                if covered_edges.insert(edge) {
                    new_edges += 1;
                }
                previous = step.pc;
            }
            let new_outcome = outcomes.insert(outcome_fingerprint(&proof));
            if (new_edges > 0 || new_outcome) && witnesses.len() < 128 {
                witnesses.push(ExplorationWitness {
                    calldata: format!("0x{}", hex::encode(bytes.as_slice())),
                    success: proof.success,
                    gas_used: proof.gas_used,
                    new_edges,
                    output: proof.output.clone(),
                    storage_diffs: proof.storage_diffs,
                });
            }
            ExitKind::Ok
        };

        #[allow(static_mut_refs)]
        let observer = unsafe {
            StdMapObserver::from_mut_ptr("revm-branch-edges", signals.as_mut_ptr(), signals.len())
        };
        let mut feedback = MaxMapFeedback::new(&observer);
        let mut objective = CrashFeedback::new();
        let mut state = StdState::new(
            StdRand::with_seed(seed),
            InMemoryCorpus::new(),
            InMemoryCorpus::new(),
            &mut feedback,
            &mut objective,
        )
        .map_err(|error| format!("LibAFL state failed: {error}"))?;
        state.set_max_size(MAX_FUZZ_INPUT_BYTES);
        let monitor = SimpleMonitor::new(|_| {});
        let mut manager = SimpleEventManager::new(monitor);
        let scheduler = QueueScheduler::new();
        let mut fuzzer = StdFuzzer::new(scheduler, feedback, objective);
        let mut executor = InProcessExecutor::new(
            &mut harness,
            tuple_list!(observer),
            &mut fuzzer,
            &mut state,
            &mut manager,
        )
        .map_err(|error| format!("LibAFL executor failed: {error}"))?;

        let mut seeds = vec![
            vec![0u8; 32],
            {
                let mut value = vec![0u8; 32];
                value[31] = 1;
                value
            },
            vec![0xffu8; 32],
        ];
        let mut seen_seeds = seeds.iter().cloned().collect::<BTreeSet<_>>();
        for value in exchange_seeds.iter().take(64) {
            if value.len() <= MAX_FUZZ_INPUT_BYTES && seen_seeds.insert(value.clone()) {
                seeds.push(value.clone());
            }
        }
        for value in seeds.into_iter().take(execution_limit) {
            fuzzer
                .add_input(
                    &mut state,
                    &mut executor,
                    &mut manager,
                    BytesInput::new(value),
                )
                .map_err(|error| format!("LibAFL seed failed: {error}"))?;
        }

        let mutator = HavocScheduledMutator::new(havoc_mutations());
        let mut stages = tuple_list!(StdMutationalStage::with_max_iterations(
            mutator,
            nonzero!(1),
        ));
        let mut stalled_rounds = 0usize;
        while (*state.executions() as usize) < execution_limit {
            let before = *state.executions();
            fuzzer
                .fuzz_one(&mut stages, &mut executor, &mut state, &mut manager)
                .map_err(|error| format!("LibAFL fuzz step failed: {error}"))?;
            if *state.executions() == before {
                stalled_rounds += 1;
                if stalled_rounds > 1_024 {
                    return Err("LibAFL mutation loop stopped producing executions.".to_owned());
                }
            } else {
                stalled_rounds = 0;
            }
        }
        *state.executions() as usize
    };

    Ok(ExplorationSummary {
        engine: "revm/36.0.0 + libafl/0.15.4",
        strategy: "libafl-queue-havoc-edge-map/0.1.0",
        executions,
        coverage_edges: covered_edges.len(),
        unique_outcomes: outcomes.len(),
        witnesses,
    })
}

#[wasm_bindgen]
pub fn engine_version() -> String {
    "revm/36.0.0".to_owned()
}

#[wasm_bindgen]
pub fn inspect_runtime(runtime_bytecode: &str, calldata: &str) -> Result<JsValue, JsValue> {
    let proof = execute(runtime_bytecode, calldata).map_err(|error| JsValue::from_str(&error))?;
    serde_wasm_bindgen::to_value(&proof).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn explore_runtime(runtime_bytecode: &str, max_executions: usize) -> Result<JsValue, JsValue> {
    let summary =
        explore(runtime_bytecode, max_executions).map_err(|error| JsValue::from_str(&error))?;
    serde_wasm_bindgen::to_value(&summary).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
#[cfg(feature = "libafl-fuzz")]
pub fn fuzz_runtime(
    runtime_bytecode: &str,
    max_executions: usize,
    seed: u64,
) -> Result<JsValue, JsValue> {
    let summary = libafl_explore(runtime_bytecode, max_executions, seed, &[])
        .map_err(|error| JsValue::from_str(&error))?;
    serde_wasm_bindgen::to_value(&summary).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
#[cfg(feature = "libafl-fuzz")]
pub fn fuzz_runtime_with_seeds(
    runtime_bytecode: &str,
    max_executions: usize,
    seed: u64,
    exchange_seeds: JsValue,
) -> Result<JsValue, JsValue> {
    let encoded: Vec<String> = serde_wasm_bindgen::from_value(exchange_seeds)
        .map_err(|error| JsValue::from_str(&format!("invalid exchange corpus: {error}")))?;
    let mut decoded = Vec::with_capacity(encoded.len().min(64));
    for value in encoded.into_iter().take(64) {
        let bytes =
            decode_hex(&value, "exchangeSeed").map_err(|error| JsValue::from_str(&error))?;
        if bytes.len() <= MAX_FUZZ_INPUT_BYTES {
            decoded.push(bytes);
        }
    }
    let summary = libafl_explore(runtime_bytecode, max_executions, seed, &decoded)
        .map_err(|error| JsValue::from_str(&error))?;
    serde_wasm_bindgen::to_value(&summary).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "libafl-fuzz")]
    #[test]
    fn emits_instruction_call_and_storage_evidence() {
        let proof = execute("0x600160005500", "0x").expect("fixture must execute");
        assert!(proof.success);
        assert!(proof.steps.iter().any(|event| event.opcode == "SSTORE"));
        assert!(proof
            .storage_operations
            .iter()
            .any(|event| event.opcode == "SSTORE"));
        assert!(!proof.calls.is_empty());
        assert!(proof
            .storage_diffs
            .iter()
            .any(|diff| diff.after.ends_with('1')));
    }

    #[test]
    fn bounded_exploration_reaches_both_calldata_state_outcomes() {
        // calldata == 0 stores 2; every non-zero corpus seed stores 1.
        let summary = explore("0x600035600014600f576001600055005b600260005500", 8)
            .expect("branch fixture must execute");
        assert_eq!(summary.executions, 8);
        assert!(summary.unique_outcomes >= 2);
        assert!(summary
            .witnesses
            .iter()
            .any(|witness| witness.calldata.ends_with('0')));
        assert!(summary
            .witnesses
            .iter()
            .any(|witness| witness.calldata.ends_with('1')));
    }

    #[test]
    fn libafl_scheduler_reaches_both_calldata_state_outcomes() {
        let summary = libafl_explore(
            "0x600035600014600f576001600055005b600260005500",
            64,
            0x484f_4f4b_5343_4f50,
            &[],
        )
        .expect("LibAFL branch fixture must execute");
        assert_eq!(summary.executions, 64);
        assert!(summary.coverage_edges >= 8);
        assert!(summary.unique_outcomes >= 2);
        assert_eq!(summary.strategy, "libafl-queue-havoc-edge-map/0.1.0");
    }
}
