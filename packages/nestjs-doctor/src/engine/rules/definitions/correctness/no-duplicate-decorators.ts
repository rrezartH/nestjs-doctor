import type { Rule } from "../../types.js";

// Decorators that are intentionally used multiple times with different arguments
const STACKABLE_DECORATORS = new Set([
	"ApiResponse",
	"ApiQuery",
	"ApiParam",
	"ApiHeader",
	"ApiSecurity",
	"SetMetadata",
	"Roles",
	"Header",
	"Throttle",
]);

export const noDuplicateDecorators: Rule = {
	meta: {
		id: "correctness/no-duplicate-decorators",
		category: "correctness",
		severity: "warning",
		description: "Same decorator should not appear twice on a single target",
		help: "Remove the duplicate decorator — it was likely copy-pasted by mistake.",
	},

	check(context) {
		for (const cls of context.sourceFile.getClasses()) {
			// Check class-level decorators
			checkDecorators(cls.getDecorators(), context, this.meta.help);

			// Check method-level decorators
			for (const method of cls.getMethods()) {
				checkDecorators(method.getDecorators(), context, this.meta.help);
			}

			// Check property-level decorators
			for (const prop of cls.getProperties()) {
				checkDecorators(prop.getDecorators(), context, this.meta.help);
			}

			// Check constructor parameter decorators
			for (const ctor of cls.getConstructors()) {
				for (const param of ctor.getParameters()) {
					checkDecorators(param.getDecorators(), context, this.meta.help);
				}
			}
		}
	},
};

function checkDecorators(
	decorators: { getName(): string; getStartLineNumber(): number }[],
	context: {
		filePath: string;
		report(diagnostic: {
			filePath: string;
			message: string;
			help: string;
			line: number;
			column: number;
		}): void;
	},
	help: string
): void {
	const seen = new Set<string>();

	for (const decorator of decorators) {
		const name = decorator.getName();

		if (STACKABLE_DECORATORS.has(name)) {
			continue;
		}

		if (seen.has(name)) {
			context.report({
				filePath: context.filePath,
				message: `Duplicate @${name}() decorator on the same target.`,
				help,
				line: decorator.getStartLineNumber(),
				column: 1,
			});
		} else {
			seen.add(name);
		}
	}
}
