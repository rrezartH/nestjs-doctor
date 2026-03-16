import { isController, isHttpHandler } from "../../../nest-class-inspector.js";
import type { Rule } from "../../types.js";

const PUBLIC_DECORATORS = new Set([
	"Public",
	"AllowAnonymous",
	"SkipAuth",
	"IsPublic",
]);

export const requireGuardsOnEndpoints: Rule = {
	meta: {
		id: "security/require-guards-on-endpoints",
		category: "security",
		severity: "warning",
		description:
			"Controller endpoints should be protected by @UseGuards() at class or method level",
		help: "Add @UseGuards(AuthGuard) to the controller class or individual route handlers, or mark routes as @Public(). If you use a global guard via APP_GUARD, you can disable this rule.",
	},

	check(context) {
		for (const cls of context.sourceFile.getClasses()) {
			if (!isController(cls)) {
				continue;
			}

			// Check for class-level @UseGuards()
			const hasClassGuard = cls.getDecorator("UseGuards") !== undefined;
			if (hasClassGuard) {
				continue;
			}

			// Check for class-level @Public() or similar decorators
			const isClassPublic = cls
				.getDecorators()
				.some((d) => PUBLIC_DECORATORS.has(d.getName()));
			if (isClassPublic) {
				continue;
			}

			for (const method of cls.getMethods()) {
				if (!isHttpHandler(method)) {
					continue;
				}

				// Check for method-level @UseGuards()
				const hasMethodGuard = method.getDecorator("UseGuards") !== undefined;
				if (hasMethodGuard) {
					continue;
				}

				// Check for @Public() or similar decorators
				const isPublic = method
					.getDecorators()
					.some((d) => PUBLIC_DECORATORS.has(d.getName()));
				if (isPublic) {
					continue;
				}

				context.report({
					filePath: context.filePath,
					message: `Endpoint '${method.getName()}' has no @UseGuards() at class or method level.`,
					help: this.meta.help,
					line: method.getStartLineNumber(),
					column: 1,
				});
			}
		}
	},
};
