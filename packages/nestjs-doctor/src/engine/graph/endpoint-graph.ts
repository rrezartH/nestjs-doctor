import type {
	ClassDeclaration,
	MethodDeclaration,
	Node,
	Project,
} from "ts-morph";
import { SyntaxKind } from "ts-morph";
import type {
	DependencyType,
	EndpointGraph,
	EndpointNode,
	MethodCallNode,
	MethodDependencyNode,
} from "../../common/endpoint.js";
import { HTTP_DECORATORS, isController } from "../nest-class-inspector.js";
import { extractSimpleTypeName, type ProviderInfo } from "./type-resolver.js";

const MAX_TRACE_DEPTH = 10;
const QUOTE_REGEX = /^['"`]|['"`]$/g;
const DUPLICATE_SLASH_REGEX = /\/+/g;
const TRAILING_SLASH_REGEX = /\/$/;

interface OrderedMethodUsage {
	conditional: boolean;
	name: string;
	order: number;
}

interface UsedDependency {
	className: string;
	methodsCalled: OrderedMethodUsage[];
}

function isInsideConditionalBlock(node: Node, boundary: Node): boolean {
	let current: Node | undefined = node;
	while (current && current !== boundary) {
		const parent = current.getParent();
		if (!parent || parent === boundary) {
			break;
		}
		const parentKind = parent.getKind();

		if (parentKind === SyntaxKind.IfStatement) {
			const ifStmt = parent.asKindOrThrow(SyntaxKind.IfStatement);
			if (
				current === ifStmt.getThenStatement() ||
				current === ifStmt.getElseStatement()
			) {
				return true;
			}
		}
		if (parentKind === SyntaxKind.ConditionalExpression) {
			const condExpr = parent.asKindOrThrow(SyntaxKind.ConditionalExpression);
			if (
				current === condExpr.getWhenTrue() ||
				current === condExpr.getWhenFalse()
			) {
				return true;
			}
		}
		const kind = current.getKind();
		if (kind === SyntaxKind.CaseClause || kind === SyntaxKind.DefaultClause) {
			return true;
		}
		if (kind === SyntaxKind.CatchClause) {
			return true;
		}

		current = parent;
	}
	return false;
}

function extractControllerPath(cls: ClassDeclaration): string {
	const decorator = cls.getDecorator("Controller");
	if (!decorator) {
		return "";
	}

	const args = decorator.getArguments();
	if (args.length === 0) {
		return "";
	}

	const firstArg = args[0];

	if (firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
		const obj = firstArg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
		const pathProp = obj.getProperty("path");
		if (!pathProp) {
			return "";
		}
		const assignment = pathProp.asKind(SyntaxKind.PropertyAssignment);
		if (!assignment) {
			return "";
		}
		const init = assignment.getInitializer();
		return init ? init.getText().replace(QUOTE_REGEX, "") : "";
	}

	return firstArg.getText().replace(QUOTE_REGEX, "");
}

function extractRouteInfo(
	method: MethodDeclaration
): { httpMethod: string; path: string } | undefined {
	for (const decorator of method.getDecorators()) {
		const name = decorator.getName();
		if (!HTTP_DECORATORS.has(name)) {
			continue;
		}

		const args = decorator.getArguments();
		const path =
			args.length > 0 ? args[0].getText().replace(QUOTE_REGEX, "") : "";

		return { httpMethod: name.toUpperCase(), path };
	}
	return undefined;
}

function composePath(controllerPath: string, methodPath: string): string {
	const parts = [controllerPath, methodPath].filter(Boolean);
	const joined = parts.join("/");
	const normalized = `/${joined}`
		.replace(DUPLICATE_SLASH_REGEX, "/")
		.replace(TRAILING_SLASH_REGEX, "");
	return normalized || "/";
}

function buildInjectionMap(cls: ClassDeclaration): Map<string, string> {
	const map = new Map<string, string>();
	const ctor = cls.getConstructors()[0];
	if (!ctor) {
		return map;
	}

	for (const param of ctor.getParameters()) {
		const name = param.getName();
		const typeNode = param.getTypeNode();
		const typeText = typeNode ? typeNode.getText() : param.getType().getText();
		map.set(name, extractSimpleTypeName(typeText));
	}

	return map;
}

function scanUsedDependencies(
	method: MethodDeclaration,
	injectionMap: Map<string, string>
): UsedDependency[] {
	const body = method.getBody();
	if (!body) {
		return [];
	}

	// Map: paramName → methodName → { isUnconditional, order }
	const usageMap = new Map<
		string,
		Map<string, { isUnconditional: boolean; order: number }>
	>();
	let callOrder = 0;
	const callExpressions = body.getDescendantsOfKind(SyntaxKind.CallExpression);

	for (const call of callExpressions) {
		const expr = call.getExpression();
		if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) {
			continue;
		}

		const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
		const methodName = propAccess.getName();
		const receiver = propAccess.getExpression();

		if (receiver.getKind() !== SyntaxKind.PropertyAccessExpression) {
			continue;
		}

		const innerAccess = receiver.asKindOrThrow(
			SyntaxKind.PropertyAccessExpression
		);
		if (innerAccess.getExpression().getKind() !== SyntaxKind.ThisKeyword) {
			continue;
		}

		const paramName = innerAccess.getName();
		if (!injectionMap.has(paramName)) {
			continue;
		}

		if (!usageMap.has(paramName)) {
			usageMap.set(paramName, new Map());
		}
		const methodMap = usageMap.get(paramName)!;
		const conditional = isInsideConditionalBlock(call, body);
		const existing = methodMap.get(methodName);
		if (existing) {
			// Keep first order, update unconditional status
			existing.isUnconditional = existing.isUnconditional || !conditional;
		} else {
			methodMap.set(methodName, {
				isUnconditional: !conditional,
				order: callOrder++,
			});
		}
	}

	const result: UsedDependency[] = [];
	for (const [paramName, methodMap] of usageMap) {
		const methods: OrderedMethodUsage[] = [];
		for (const [name, info] of methodMap) {
			methods.push({
				name,
				conditional: !info.isUnconditional,
				order: info.order,
			});
		}
		methods.sort((a, b) => a.order - b.order);
		result.push({
			className: injectionMap.get(paramName)!,
			methodsCalled: methods,
		});
	}

	return result;
}

function classifyDependency(name: string): DependencyType {
	if (name.endsWith("Repository")) {
		return "repository";
	}
	if (name.endsWith("Guard")) {
		return "guard";
	}
	if (name.endsWith("Interceptor")) {
		return "interceptor";
	}
	if (name.endsWith("Pipe")) {
		return "pipe";
	}
	if (name.endsWith("Filter")) {
		return "filter";
	}
	if (name.endsWith("Gateway")) {
		return "gateway";
	}
	return "service";
}

function buildMethodDependencyTree(
	usedDeps: UsedDependency[],
	providers: Map<string, ProviderInfo>,
	visited: Set<string>
): MethodDependencyNode[] {
	const nodes: MethodDependencyNode[] = [];
	const firstSeenClass = new Set<string>();

	// Build a flat list of all individual method calls across all deps
	interface FlatCall {
		className: string;
		/** Reference to the full UsedDependency for scanning sub-deps */
		dep: UsedDependency;
		mc: OrderedMethodUsage;
	}

	const flatCalls: FlatCall[] = [];
	const fallbackDeps: UsedDependency[] = [];

	for (const dep of usedDeps) {
		if (dep.methodsCalled.length === 0) {
			fallbackDeps.push(dep);
		} else {
			for (const mc of dep.methodsCalled) {
				flatCalls.push({ className: dep.className, mc, dep });
			}
		}
	}

	// Sort by global call order
	flatCalls.sort((a, b) => a.mc.order - b.mc.order);

	// Process fallback deps first (no method tracking)
	for (const dep of fallbackDeps) {
		if (visited.has(dep.className) || firstSeenClass.has(dep.className)) {
			continue;
		}
		firstSeenClass.add(dep.className);
		visited.add(dep.className);

		const provider = providers.get(dep.className);
		let childDeps: UsedDependency[] = [];
		if (provider) {
			childDeps = provider.dependencies.map((d) => ({
				className: d,
				methodsCalled: [],
			}));
		}

		nodes.push({
			className: dep.className,
			conditional: false,
			dependencies: buildMethodDependencyTree(
				childDeps,
				providers,
				new Set(visited)
			),
			filePath: provider?.filePath ?? "",
			line: 0,
			methodName: null,
			order: 0,
			totalMethods: provider?.publicMethodCount ?? 0,
			type: classifyDependency(dep.className),
		});
	}

	// Collect all methods per class for sub-dep scanning
	const allMethodsByClass = new Map<string, OrderedMethodUsage[]>();
	for (const { className, dep } of flatCalls) {
		if (!allMethodsByClass.has(className)) {
			allMethodsByClass.set(className, dep.methodsCalled);
		}
	}

	// Process method calls in global order
	for (const { className, mc } of flatCalls) {
		// Skip classes already in the ancestor chain (circular dep)
		if (visited.has(className)) {
			continue;
		}

		const provider = providers.get(className);
		const isFirst = !firstSeenClass.has(className);
		if (isFirst) {
			firstSeenClass.add(className);
		}

		let childNodes: MethodDependencyNode[] = [];

		if (isFirst && provider) {
			const childVisited = new Set(visited);
			childVisited.add(className);
			const injMap = buildInjectionMap(provider.classDeclaration);

			// Merge sub-deps from ALL methods of this class
			const merged = new Map<
				string,
				Map<string, { isUnconditional: boolean; order: number }>
			>();
			let childOrder = 0;
			const classMethods = allMethodsByClass.get(className) ?? [];
			for (const allMc of classMethods) {
				const method = provider.classDeclaration.getInstanceMethod(allMc.name);
				if (!method) {
					continue;
				}
				for (const used of scanUsedDependencies(method, injMap)) {
					if (!merged.has(used.className)) {
						merged.set(used.className, new Map());
					}
					const methodMap = merged.get(used.className)!;
					for (const m of used.methodsCalled) {
						const existing = methodMap.get(m.name);
						if (existing) {
							existing.isUnconditional =
								existing.isUnconditional || !m.conditional;
						} else {
							methodMap.set(m.name, {
								isUnconditional: !m.conditional,
								order: childOrder++,
							});
						}
					}
				}
			}

			const childDeps: UsedDependency[] = [...merged.entries()].map(
				([cn, methodMap]) => ({
					className: cn,
					methodsCalled: [...methodMap.entries()]
						.map(([name, info]) => ({
							name,
							conditional: !info.isUnconditional,
							order: info.order,
						}))
						.sort((a, b) => a.order - b.order),
				})
			);

			childNodes = buildMethodDependencyTree(
				childDeps,
				providers,
				childVisited
			);
		}

		let line = 0;
		if (provider) {
			const methodDecl = provider.classDeclaration.getInstanceMethod(mc.name);
			if (methodDecl) {
				line = methodDecl.getStartLineNumber();
			}
		}

		nodes.push({
			className,
			conditional: mc.conditional,
			dependencies: childNodes,
			filePath: provider?.filePath ?? "",
			line,
			methodName: mc.name,
			order: mc.order,
			totalMethods: provider?.publicMethodCount ?? 0,
			type: classifyDependency(className),
		});
	}

	return nodes;
}

function extractEndpointsFromFile(
	sourceFile: NonNullable<ReturnType<Project["getSourceFile"]>>,
	filePath: string,
	providers: Map<string, ProviderInfo>
): EndpointNode[] {
	const endpoints: EndpointNode[] = [];

	for (const cls of sourceFile.getClasses()) {
		if (!isController(cls)) {
			continue;
		}

		const controllerPath = extractControllerPath(cls);
		const controllerName = cls.getName() ?? "AnonymousController";
		const injectionMap = buildInjectionMap(cls);

		for (const method of cls.getMethods()) {
			const routeInfo = extractRouteInfo(method);
			if (!routeInfo) {
				continue;
			}

			const fullPath = composePath(controllerPath, routeInfo.path);
			const usedDeps = scanUsedDependencies(method, injectionMap);
			const dependencies = buildMethodDependencyTree(
				usedDeps,
				providers,
				new Set()
			);

			endpoints.push({
				controllerClass: controllerName,
				dependencies,
				filePath,
				handlerMethod: method.getName(),
				httpMethod: routeInfo.httpMethod,
				line: method.getStartLineNumber(),
				routePath: fullPath,
			});
		}
	}

	return endpoints;
}

export function buildEndpointGraph(
	project: Project,
	files: string[],
	providers: Map<string, ProviderInfo>
): EndpointGraph {
	const endpoints: EndpointNode[] = [];

	for (const filePath of files) {
		const sourceFile = project.getSourceFile(filePath);
		if (!sourceFile) {
			continue;
		}

		endpoints.push(
			...extractEndpointsFromFile(sourceFile, filePath, providers)
		);
	}

	return { endpoints };
}

function traceMethodCalls(
	method: MethodDeclaration,
	injectionMap: Map<string, string>,
	providers: Map<string, ProviderInfo>,
	visited: Set<string>,
	depth: number,
	currentClass?: ClassDeclaration
): MethodCallNode[] {
	if (depth > MAX_TRACE_DEPTH) {
		return [];
	}

	const body = method.getBody();
	if (!body) {
		return [];
	}

	const calls: MethodCallNode[] = [];
	const callExpressions = body.getDescendantsOfKind(SyntaxKind.CallExpression);

	for (const call of callExpressions) {
		const expr = call.getExpression();
		if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) {
			continue;
		}

		const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
		const methodName = propAccess.getName();
		const receiver = propAccess.getExpression();

		// Pattern: this.service.method() — injected dependency call
		if (receiver.getKind() === SyntaxKind.PropertyAccessExpression) {
			const innerAccess = receiver.asKindOrThrow(
				SyntaxKind.PropertyAccessExpression
			);
			if (innerAccess.getExpression().getKind() !== SyntaxKind.ThisKeyword) {
				continue;
			}

			const paramName = innerAccess.getName();
			const className = injectionMap.get(paramName);
			if (!className) {
				continue;
			}

			const key = `${className}.${methodName}`;
			if (visited.has(key)) {
				calls.push({
					calls: [],
					circular: true,
					className,
					filePath: "",
					line: 0,
					methodName,
				});
				continue;
			}

			visited.add(key);

			const provider = providers.get(className);
			let childCalls: MethodCallNode[] = [];
			let filePath = "";
			let line = 0;

			if (provider) {
				filePath = provider.filePath;
				const targetMethod =
					provider.classDeclaration.getInstanceMethod(methodName);
				if (targetMethod) {
					line = targetMethod.getStartLineNumber();
					const targetInjectionMap = buildInjectionMap(
						provider.classDeclaration
					);
					childCalls = traceMethodCalls(
						targetMethod,
						targetInjectionMap,
						providers,
						new Set(visited),
						depth + 1,
						provider.classDeclaration
					);
				}
			}

			calls.push({
				calls: childCalls,
				className,
				filePath,
				line,
				methodName,
			});
		}

		// Pattern: this.method() — same-class private method call
		// Inline children: follow into the private method and surface its dependency calls
		else if (receiver.getKind() === SyntaxKind.ThisKeyword && currentClass) {
			const targetMethod = currentClass.getInstanceMethod(methodName);
			if (!targetMethod) {
				continue;
			}

			const className = currentClass.getName() ?? "Anonymous";
			const key = `${className}.${methodName}`;
			if (visited.has(key)) {
				continue;
			}
			visited.add(key);

			const childCalls = traceMethodCalls(
				targetMethod,
				injectionMap,
				providers,
				new Set(visited),
				depth + 1,
				currentClass
			);

			// Inline: surface dependency calls from private methods directly
			calls.push(...childCalls);
		}
	}

	return calls;
}

/**
 * Layer 2: traces method-level call chains for a specific endpoint.
 * Returns the full recursive call tree through injected dependencies.
 */
export function traceEndpointCalls(
	endpoint: EndpointNode,
	providers: Map<string, ProviderInfo>,
	project: Project
): MethodCallNode[] {
	const sourceFile = project.getSourceFile(endpoint.filePath);
	if (!sourceFile) {
		return [];
	}

	const cls = sourceFile
		.getClasses()
		.find((c) => c.getName() === endpoint.controllerClass);
	if (!cls) {
		return [];
	}

	const method = cls.getInstanceMethod(endpoint.handlerMethod);
	if (!method) {
		return [];
	}

	const injectionMap = buildInjectionMap(cls);
	return traceMethodCalls(method, injectionMap, providers, new Set(), 0, cls);
}

export function updateEndpointGraphForFile(
	graph: EndpointGraph,
	project: Project,
	filePath: string,
	providers: Map<string, ProviderInfo>
): void {
	// Remove stale endpoints from this file
	graph.endpoints = graph.endpoints.filter((e) => e.filePath !== filePath);

	// Re-scan the changed file
	const sourceFile = project.getSourceFile(filePath);
	if (!sourceFile) {
		return;
	}

	graph.endpoints.push(
		...extractEndpointsFromFile(sourceFile, filePath, providers)
	);
}
