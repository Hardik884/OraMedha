/**
 * Business Brain — Clinic Memory barrel.
 *
 * Derived, revalidated, clinic-scoped memory over stored evidence, and the
 * controlled reader future components use. Pure: no reads, no writes, no model.
 */
export { deriveClinicMemory, digestOf, memoryId, MemoryIntegrityError, resolveDecisions, type ClinicMemoryInput } from "./memory-engine";
export { ClinicMemoryReader, type MemoryAnswer, type ReadOptions, type UnusualAnswer } from "./memory-reader";
export { DEFAULT_MEMORY_CONFIG, MEMORY_DERIVATION_VERSION, RANGE_METRIC_KEYS, WEEKDAY_METRIC_KEYS, type MemoryConfig } from "./memory-config";
