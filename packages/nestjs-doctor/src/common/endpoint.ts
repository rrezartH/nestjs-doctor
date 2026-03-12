/**
 * Classifies a dependency's role in the NestJS application.
 */
export type DependencyType =
	| "service"
	| "repository"
	| "guard"
	| "interceptor"
	| "pipe"
	| "filter"
	| "gateway"
	| "unknown";

/**
 * A per-method dependency node. Each method call becomes its own node
 * so that call order and conditionality are visible in the graph.
 */
export interface MethodDependencyNode {
	className: string;
	conditional: boolean;
	dependencies: MethodDependencyNode[];
	filePath: string;
	line: number;
	methodName: string | null;
	order: number;
	totalMethods: number;
	type: DependencyType;
}

/**
 * Represents a single HTTP endpoint in a NestJS controller.
 * Contains a per-method dependency tree.
 */
export interface EndpointNode {
	controllerClass: string;
	dependencies: MethodDependencyNode[];
	filePath: string;
	handlerMethod: string;
	httpMethod: string;
	line: number;
	routePath: string;
}

/**
 * Layer 2: method-level call trace node for deep dependency analysis.
 * Computed on demand via traceEndpointCalls().
 */
export interface MethodCallNode {
	calls: MethodCallNode[];
	circular?: boolean;
	className: string;
	filePath: string;
	line: number;
	methodName: string;
}

/**
 * Complete endpoint dependency graph for a NestJS project.
 * JSON-safe — contains no Maps or AST references.
 */
export interface EndpointGraph {
	endpoints: EndpointNode[];
}
