import { SyntaxKind } from "ts-morph";
import type { Rule } from "../../types.js";

const EACH_TRUE_REGEX = /each\s*:\s*true/;

export const validateNestedArrayEach: Rule = {
	meta: {
		id: "correctness/validate-nested-array-each",
		category: "correctness",
		severity: "warning",
		description:
			"@ValidateNested() on array-typed properties must use { each: true }",
		help: "Change @ValidateNested() to @ValidateNested({ each: true }) for array properties.",
	},

	check(context) {
		for (const cls of context.sourceFile.getClasses()) {
			for (const prop of cls.getProperties()) {
				const decorators = prop.getDecorators();

				const validateNestedDec = decorators.find(
					(d) => d.getName() === "ValidateNested"
				);
				if (!validateNestedDec) {
					continue;
				}

				// Determine if the property is array-typed
				const isArrayType = isPropertyArrayTyped(prop);
				const hasIsArrayDecorator = decorators.some(
					(d) => d.getName() === "IsArray"
				);
				const isArray = isArrayType || hasIsArrayDecorator;

				if (!isArray) {
					continue;
				}

				// Check if @ValidateNested has { each: true }
				const hasEach = hasEachTrue(validateNestedDec);

				if (!hasEach) {
					context.report({
						filePath: context.filePath,
						message: `Property '${prop.getName()}' is an array with @ValidateNested() but missing { each: true }.`,
						help: this.meta.help,
						line: validateNestedDec.getStartLineNumber(),
						column: 1,
					});
				}
			}
		}
	},
};

function isPropertyArrayTyped(prop: {
	getTypeNode(): { getText(): string } | undefined;
}): boolean {
	const typeNode = prop.getTypeNode();
	if (!typeNode) {
		return false;
	}

	const typeText = typeNode.getText().replace(/\s/g, "");

	// T[] syntax
	if (typeText.endsWith("[]")) {
		return true;
	}

	// Array<T> syntax
	if (typeText.startsWith("Array<")) {
		return true;
	}

	return false;
}

function hasEachTrue(decorator: {
	getArguments(): { getKind(): SyntaxKind; getText(): string }[];
}): boolean {
	const args = decorator.getArguments();
	if (args.length === 0) {
		return false;
	}

	const firstArg = args[0];
	if (firstArg.getKind() !== SyntaxKind.ObjectLiteralExpression) {
		return false;
	}

	// Check for { each: true } in the argument text
	const text = firstArg.getText();
	return EACH_TRUE_REGEX.test(text);
}
