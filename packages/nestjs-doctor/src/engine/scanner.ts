import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Project } from "ts-morph";
import type { NestjsDoctorConfig } from "../common/config.js";
import type { Diagnostic } from "../common/diagnostic.js";
import type {
	DiagnoseResult,
	DiagnoseSummary,
	MonorepoResult,
	ProjectInfo,
	RuleErrorInfo,
	SubProjectResult,
} from "../common/result.js";
import type { SchemaGraph } from "../common/schema.js";
import { createAstParser } from "./ast-parser.js";
import { loadConfig } from "./config-loader.js";
import { collectFiles, collectMonorepoFiles } from "./file-collector.js";
import { filterIgnoredDiagnostics } from "./filter-diagnostics.js";
import {
	buildModuleGraph,
	type ModuleGraph,
	updateModuleGraphForFile,
} from "./module-graph.js";
import {
	detectMonorepo,
	detectProject,
	type MonorepoInfo,
} from "./project-detector.js";
import { mergeRules, resolveCustomRules } from "./rule-resolver.js";
import {
	type RunRulesOptions,
	runFileRules,
	runProjectRules,
	runSchemaRules,
	separateRules,
} from "./rule-runner.js";
import { allRules } from "./rules/index.js";
import type { AnyRule, ProjectRule, Rule, SchemaRule } from "./rules/types.js";
import {
	extractSchema,
	serializeSchemaGraph,
	updateSchemaForFile,
} from "./schema/extract.js";
import { calculateScore } from "./scorer/index.js";
import type { ProviderInfo } from "./type-resolver.js";
import { resolveProviders, updateProvidersForFile } from "./type-resolver.js";

function formatRuleError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export interface ScanResult {
	customRuleWarnings: string[];
	files: string[];
	moduleGraph: ModuleGraph;
	providers: Map<string, ProviderInfo>;
	result: DiagnoseResult;
	schemaGraph: SchemaGraph;
}

export interface MonorepoScanResult {
	customRuleWarnings: string[];
	moduleGraphs: Map<string, ModuleGraph>;
	result: MonorepoResult;
}

export interface ScanContext {
	astProject: Project;
	config: NestjsDoctorConfig;
	fileRules: Rule[];
	files: string[];
	moduleGraph: ModuleGraph;
	project: ProjectInfo;
	projectRules: ProjectRule[];
	providers: Map<string, ProviderInfo>;
	schemaGraph?: SchemaGraph;
	schemaRules: SchemaRule[];
	targetPath: string;
}

export interface ScanConfig {
	combinedRules: AnyRule[];
	config: NestjsDoctorConfig;
	customRuleWarnings: string[];
	fileRules: Rule[];
	projectRules: ProjectRule[];
	schemaRules: SchemaRule[];
}

export interface MonorepoContext {
	subProjects: Map<string, ScanContext>;
}

export async function resolveScanConfig(
	targetPath: string,
	configPath?: string
): Promise<ScanConfig> {
	const config = await loadConfig(targetPath, configPath);

	const { rules: customRules, warnings: customRuleWarnings } =
		await resolveCustomRules(config, targetPath);
	const combinedRules = mergeRules(allRules, customRules, customRuleWarnings);

	const rules = filterRules(config, combinedRules);
	const { fileRules, projectRules, schemaRules } = separateRules(rules);

	return {
		combinedRules,
		config,
		customRuleWarnings,
		fileRules,
		projectRules,
		schemaRules,
	};
}

export async function buildScanContext(
	targetPath: string,
	scanConfig: ScanConfig
): Promise<ScanContext> {
	const { config, fileRules, projectRules, schemaRules } = scanConfig;
	const [files, project] = await Promise.all([
		collectFiles(targetPath, config),
		detectProject(targetPath),
	]);
	const astProject = createAstParser(files);
	const moduleGraph = buildModuleGraph(astProject, files);
	const providers = resolveProviders(astProject, files);
	const schemaGraph = extractSchema(astProject, files, project.orm, targetPath);

	return {
		astProject,
		config,
		fileRules,
		files,
		moduleGraph,
		project,
		projectRules,
		providers,
		schemaGraph,
		schemaRules,
		targetPath,
	};
}

export async function prepareScan(
	targetPath: string,
	options: { config?: string } = {}
): Promise<{ context: ScanContext; customRuleWarnings: string[] }> {
	const scanConfig = await resolveScanConfig(targetPath, options.config);
	const context = await buildScanContext(targetPath, scanConfig);
	return { context, customRuleWarnings: scanConfig.customRuleWarnings };
}

export function updateFile(context: ScanContext, filePath: string): void {
	const existing = context.astProject.getSourceFile(filePath);
	if (existing) {
		context.astProject.removeSourceFile(existing);
	}

	context.astProject.addSourceFileAtPath(filePath);

	if (!context.files.includes(filePath)) {
		context.files.push(filePath);
	}

	updateModuleGraphForFile(context.moduleGraph, context.astProject, filePath);
	updateProvidersForFile(context.providers, context.astProject, filePath);
	if (context.schemaGraph) {
		updateSchemaForFile(
			context.schemaGraph,
			context.astProject,
			filePath,
			context.targetPath
		);
	}
}

function processResults(
	rawDiagnostics: Diagnostic[],
	errors: { ruleId: string; error: unknown }[],
	context: ScanContext
): { diagnostics: Diagnostic[]; errors: RuleErrorInfo[] } {
	const diagnostics = filterIgnoredDiagnostics(
		rawDiagnostics,
		context.config,
		context.targetPath
	);
	const ruleErrors: RuleErrorInfo[] = errors.map((e) => ({
		ruleId: e.ruleId,
		error: formatRuleError(e.error),
	}));
	return { diagnostics, errors: ruleErrors };
}

export function checkFile(
	context: ScanContext,
	filePath: string
): { diagnostics: Diagnostic[]; errors: RuleErrorInfo[] } {
	const result = runFileRules(
		context.astProject,
		[filePath],
		context.fileRules,
		context.config
	);
	return processResults(result.diagnostics, result.errors, context);
}

export function checkAllFiles(context: ScanContext): {
	diagnostics: Diagnostic[];
	errors: RuleErrorInfo[];
} {
	const result = runFileRules(
		context.astProject,
		context.files,
		context.fileRules,
		context.config
	);
	return processResults(result.diagnostics, result.errors, context);
}

export function checkProject(context: ScanContext): {
	diagnostics: Diagnostic[];
	errors: RuleErrorInfo[];
} {
	const options: RunRulesOptions = {
		moduleGraph: context.moduleGraph,
		providers: context.providers,
		config: context.config,
	};
	const result = runProjectRules(
		context.astProject,
		context.files,
		context.projectRules,
		options
	);
	const { diagnostics, errors } = processResults(
		result.diagnostics,
		result.errors,
		context
	);
	const schemaResult = checkSchema(context);
	diagnostics.push(...schemaResult.diagnostics);
	errors.push(...schemaResult.errors);

	return { diagnostics, errors };
}

export function checkSchema(context: ScanContext): {
	diagnostics: Diagnostic[];
	errors: RuleErrorInfo[];
} {
	if (!context.schemaGraph || context.schemaRules.length === 0) {
		return { diagnostics: [], errors: [] };
	}

	if (context.schemaGraph.entities.size === 0) {
		return { diagnostics: [], errors: [] };
	}

	const result = runSchemaRules(context.schemaGraph, context.schemaRules);
	return processResults(result.diagnostics, result.errors, context);
}

export interface RawScanOutput {
	diagnostics: Diagnostic[];
	elapsedMs: number;
	ruleErrors: RuleErrorInfo[];
}

export function runRules(context: ScanContext): RawScanOutput {
	const startTime = performance.now();
	const fileResult = checkAllFiles(context);
	const projectResult = checkProject(context);
	const elapsedMs = performance.now() - startTime;
	return {
		diagnostics: [...fileResult.diagnostics, ...projectResult.diagnostics],
		elapsedMs,
		ruleErrors: [...fileResult.errors, ...projectResult.errors],
	};
}

export function buildScanResult(
	context: ScanContext,
	rawOutput: RawScanOutput,
	customRuleWarnings: string[] = []
): ScanResult {
	const { diagnostics, ruleErrors, elapsedMs } = rawOutput;
	const schemaGraph =
		context.schemaGraph ??
		extractSchema(
			context.astProject,
			context.files,
			context.project.orm,
			context.targetPath
		);
	const score = calculateScore(diagnostics, context.files.length);
	const summary = buildSummary(diagnostics);
	const result: DiagnoseResult = {
		score,
		diagnostics,
		project: {
			...context.project,
			fileCount: context.files.length,
			moduleCount: context.moduleGraph.modules.size,
		},
		summary,
		ruleErrors,
		elapsedMs,
		schema: serializeSchemaGraph(schemaGraph),
	};
	return {
		result,
		moduleGraph: context.moduleGraph,
		schemaGraph,
		customRuleWarnings,
		files: context.files,
		providers: context.providers,
	};
}

function filterRules(config: NestjsDoctorConfig, rules: AnyRule[]) {
	return rules.filter((rule) => {
		const ruleConfig = config.rules?.[rule.meta.id];
		if (ruleConfig === false) {
			return false;
		}
		if (typeof ruleConfig === "object" && ruleConfig.enabled === false) {
			return false;
		}

		const categoryEnabled = config.categories?.[rule.meta.category];
		if (categoryEnabled === false) {
			return false;
		}

		return true;
	});
}

export async function buildMonorepoContext(
	targetPath: string,
	scanConfig: ScanConfig,
	monorepo: MonorepoInfo
): Promise<MonorepoContext> {
	const { config: rootConfig, combinedRules } = scanConfig;
	const filesByProject = await collectMonorepoFiles(
		targetPath,
		monorepo,
		rootConfig
	);

	const entries = await Promise.all(
		[...filesByProject.entries()]
			.filter(([, files]) => files.length > 0)
			.map(async ([name, files]): Promise<[string, ScanContext]> => {
				const projectPath = join(targetPath, monorepo.projects.get(name)!);
				const [project, projectConfig] = await Promise.all([
					detectProject(projectPath),
					loadConfigWithFallback(projectPath, rootConfig),
				]);

				const astProject = createAstParser(files);
				const moduleGraph = buildModuleGraph(astProject, files);
				const providers = resolveProviders(astProject, files);
				const schemaGraph = extractSchema(
					astProject,
					files,
					project.orm,
					projectPath
				);
				const rules = filterRules(projectConfig, combinedRules);
				const { fileRules, projectRules, schemaRules } = separateRules(rules);

				return [
					name,
					{
						astProject,
						config: projectConfig,
						fileRules,
						files,
						moduleGraph,
						project,
						projectRules,
						providers,
						schemaGraph,
						schemaRules,
						targetPath: projectPath,
					},
				];
			})
	);

	return { subProjects: new Map(entries) };
}

export function buildMonorepoResult(
	monorepoCtx: MonorepoContext,
	rawOutputs: Map<string, RawScanOutput>,
	customRuleWarnings: string[],
	totalElapsedMs: number
): MonorepoScanResult {
	const subProjects: SubProjectResult[] = [];
	const allDiagnostics: Diagnostic[] = [];
	const allRuleErrors: RuleErrorInfo[] = [];
	const moduleGraphs = new Map<string, ModuleGraph>();
	let totalFiles = 0;

	for (const [name, context] of monorepoCtx.subProjects) {
		const rawOutput = rawOutputs.get(name)!;
		const scanResult = buildScanResult(context, rawOutput);
		subProjects.push({ name, result: scanResult.result });
		moduleGraphs.set(name, scanResult.moduleGraph);
		allDiagnostics.push(...scanResult.result.diagnostics);
		allRuleErrors.push(...scanResult.result.ruleErrors);
		totalFiles += scanResult.result.project.fileCount;
	}

	const combinedScore = calculateScore(allDiagnostics, totalFiles);
	const combinedSummary = buildSummary(allDiagnostics);

	const combined: DiagnoseResult = {
		score: combinedScore,
		diagnostics: allDiagnostics,
		project: {
			name: "monorepo",
			nestVersion: subProjects[0]?.result.project.nestVersion ?? null,
			orm: subProjects[0]?.result.project.orm ?? null,
			framework: subProjects[0]?.result.project.framework ?? null,
			fileCount: totalFiles,
			moduleCount: subProjects.reduce(
				(sum, sp) => sum + sp.result.project.moduleCount,
				0
			),
		},
		summary: combinedSummary,
		ruleErrors: allRuleErrors,
		elapsedMs: totalElapsedMs,
	};

	return {
		moduleGraphs,
		customRuleWarnings,
		result: {
			isMonorepo: true,
			subProjects,
			combined,
			elapsedMs: totalElapsedMs,
		},
	};
}

export async function scanMonorepo(
	targetPath: string,
	scanConfig: ScanConfig,
	monorepo: MonorepoInfo
): Promise<MonorepoScanResult> {
	const startTime = performance.now();
	const ctx = await buildMonorepoContext(targetPath, scanConfig, monorepo);
	const rawOutputs = new Map<string, RawScanOutput>();
	for (const [name, context] of ctx.subProjects) {
		rawOutputs.set(name, runRules(context));
	}
	const totalElapsedMs = performance.now() - startTime;
	return buildMonorepoResult(
		ctx,
		rawOutputs,
		scanConfig.customRuleWarnings,
		totalElapsedMs
	);
}

export type AutoScanResult =
	| { isMonorepo: true; monorepo: MonorepoScanResult }
	| { isMonorepo: false; single: ScanResult };

export async function autoScan(
	targetPath: string,
	options: { config?: string; monorepo?: MonorepoInfo } = {}
): Promise<AutoScanResult> {
	const scanConfig = await resolveScanConfig(targetPath, options.config);
	const detected = await detectMonorepo(targetPath);
	if (detected) {
		const result = await scanMonorepo(targetPath, scanConfig, detected);
		return { isMonorepo: true, monorepo: result };
	}
	const context = await buildScanContext(targetPath, scanConfig);
	const rawOutput = runRules(context);
	const result = buildScanResult(
		context,
		rawOutput,
		scanConfig.customRuleWarnings
	);
	return { isMonorepo: false, single: result };
}

async function loadConfigWithFallback(
	projectPath: string,
	fallback: NestjsDoctorConfig
): Promise<NestjsDoctorConfig> {
	try {
		return await loadConfig(projectPath);
	} catch {
		return fallback;
	}
}

function buildSummary(diagnostics: Diagnostic[]): DiagnoseSummary {
	const summary: DiagnoseSummary = {
		total: 0,
		errors: 0,
		warnings: 0,
		info: 0,
		byCategory: {
			security: 0,
			performance: 0,
			correctness: 0,
			architecture: 0,
			schema: 0,
		},
	};

	for (const d of diagnostics) {
		summary.total++;
		if (d.severity === "error") {
			summary.errors++;
		} else if (d.severity === "warning") {
			summary.warnings++;
		} else {
			summary.info++;
		}
		summary.byCategory[d.category]++;
	}

	return summary;
}
