import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ValidationError } from "../common/errors.js";
import type { MonorepoResult } from "../common/result.js";
import { detectMonorepo } from "../engine/project-detector.js";
import {
	buildScanContext,
	buildScanResult,
	resolveScanConfig,
	runRules,
	scanMonorepo,
} from "../engine/scanner.js";

export type { NestjsDoctorConfig } from "../common/config.js";
export type {
	BaseDiagnostic,
	Category,
	CodeDiagnostic,
	Diagnostic,
	SchemaDiagnostic,
	Severity,
} from "../common/diagnostic.js";
// biome-ignore lint/performance/noBarrelFile: this is the public API surface
export {
	isCodeDiagnostic,
	isSchemaDiagnostic,
} from "../common/diagnostic.js";
export {
	ConfigurationError,
	NestjsDoctorError,
	ScanError,
	ValidationError,
} from "../common/errors.js";
export type {
	DiagnoseResult,
	DiagnoseSummary,
	MonorepoResult,
	ProjectInfo,
	RuleErrorInfo,
	Score,
	SubProjectResult,
} from "../common/result.js";
export type {
	SchemaColumn,
	SchemaEntity,
	SchemaGraph,
	SchemaRelation,
	SerializedSchemaGraph,
} from "../common/schema.js";
export { updateModuleGraphForFile } from "../engine/module-graph.js";
export { getRules } from "../engine/rules/index.js";
export type {
	AnyRule,
	CodeRuleContext,
	CodeRuleContext as RuleContext,
	ProjectRule,
	ProjectRuleContext,
	Rule,
	RuleMeta,
	SchemaRule,
	SchemaRuleContext,
} from "../engine/rules/types.js";
export type {
	AutoScanResult,
	RawScanOutput,
	ScanConfig,
	ScanContext,
} from "../engine/scanner.js";
export {
	autoScan,
	buildScanContext,
	buildScanResult,
	checkAllFiles,
	checkFile,
	checkProject,
	checkSchema,
	prepareScan,
	resolveScanConfig,
	updateFile,
} from "../engine/scanner.js";
export { extractSchema } from "../engine/schema/extract.js";
export { updateProvidersForFile } from "../engine/type-resolver.js";

function validatePath(path: string): string {
	if (!path || path.trim() === "") {
		throw new ValidationError(
			"Path must be a non-empty string. Received an empty path."
		);
	}

	const resolved = resolve(path);

	if (!existsSync(resolved)) {
		throw new ValidationError(`Path does not exist: ${resolved}`);
	}

	const stat = statSync(resolved);
	if (!stat.isDirectory()) {
		throw new ValidationError(
			`Path must be a directory, not a file: ${resolved}`
		);
	}

	return resolved;
}

/**
 * Scans a single NestJS project and returns a health diagnostic result.
 *
 * @param path - Path to the NestJS project root directory.
 * @param options - Optional configuration: `config` specifies a path to a config file.
 * @returns A `DiagnoseResult` containing the health score, diagnostics, and summary.
 * @throws {ValidationError} If the path is empty, doesn't exist, or isn't a directory.
 */
export async function diagnose(
	path: string,
	options: { config?: string } = {}
) {
	const targetPath = validatePath(path);
	const scanConfig = await resolveScanConfig(targetPath, options.config);
	const context = await buildScanContext(targetPath, scanConfig);
	const rawOutput = runRules(context);
	const { result } = buildScanResult(
		context,
		rawOutput,
		scanConfig.customRuleWarnings
	);
	return result;
}

/**
 * Scans a NestJS monorepo and returns per-project and combined diagnostics.
 *
 * Auto-detects monorepo structure from `nest-cli.json`. If the target is not a
 * monorepo, falls back to a single-project scan wrapped in the monorepo result format.
 *
 * @param path - Path to the monorepo root directory.
 * @param options - Optional configuration: `config` specifies a path to a config file.
 * @returns A `MonorepoResult` with sub-project results and combined score.
 * @throws {ValidationError} If the path is empty, doesn't exist, or isn't a directory.
 */
export async function diagnoseMonorepo(
	path: string,
	options: { config?: string } = {}
) {
	const targetPath = validatePath(path);
	const scanConfig = await resolveScanConfig(targetPath, options.config);
	const monorepo = await detectMonorepo(targetPath);

	if (!monorepo) {
		const context = await buildScanContext(targetPath, scanConfig);
		const rawOutput = runRules(context);
		const { result } = buildScanResult(
			context,
			rawOutput,
			scanConfig.customRuleWarnings
		);
		return {
			isMonorepo: false,
			subProjects: [{ name: "default", result }],
			combined: result,
			elapsedMs: result.elapsedMs,
		} satisfies MonorepoResult;
	}

	const { result } = await scanMonorepo(targetPath, scanConfig, monorepo);
	return result;
}
