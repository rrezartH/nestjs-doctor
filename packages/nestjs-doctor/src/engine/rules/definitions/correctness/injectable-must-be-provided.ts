import { SyntaxKind } from "ts-morph";
import { isModule } from "../../../nest-class-inspector.js";
import { INFRA_SUFFIXES } from "../../constants.js";
import type { ProjectRule } from "../../types.js";

export const injectableMustBeProvided: ProjectRule = {
	meta: {
		id: "correctness/injectable-must-be-provided",
		category: "correctness",
		severity: "info",
		description:
			"@Injectable() classes should be registered in at least one module's providers array",
		help: "Add this class to a module's providers array, or remove the @Injectable() decorator if unused.",
		scope: "project",
	},

	check(context) {
		// Collect all provider names registered in module metadata
		const registeredProviders = new Set<string>();
		for (const mod of context.moduleGraph.modules.values()) {
			for (const provider of mod.providers) {
				registeredProviders.add(provider);
			}
			for (const controller of mod.controllers) {
				registeredProviders.add(controller);
			}
		}

		// Also collect useClass/useExisting targets from object-literal providers
		for (const filePath of context.files) {
			const sourceFile = context.project.getSourceFile(filePath);
			if (!sourceFile) {
				continue;
			}
			for (const cls of sourceFile.getClasses()) {
				if (!isModule(cls)) {
					continue;
				}
				const moduleDecorator = cls.getDecorator("Module");
				if (!moduleDecorator) {
					continue;
				}
				const args = moduleDecorator.getArguments()[0];
				if (!args || args.getKind() !== SyntaxKind.ObjectLiteralExpression) {
					continue;
				}
				const obj = args.asKind(SyntaxKind.ObjectLiteralExpression);
				if (!obj) {
					continue;
				}
				const providersProp = obj.getProperty("providers");
				if (!providersProp) {
					continue;
				}
				const providersArray = providersProp.getChildrenOfKind(
					SyntaxKind.ArrayLiteralExpression
				)[0];
				if (!providersArray) {
					continue;
				}
				for (const element of providersArray.getElements()) {
					if (element.getKind() !== SyntaxKind.ObjectLiteralExpression) {
						continue;
					}
					const providerObj = element.asKind(
						SyntaxKind.ObjectLiteralExpression
					);
					if (!providerObj) {
						continue;
					}
					for (const propName of ["useClass", "useExisting"]) {
						const prop = providerObj.getProperty(propName);
						if (!prop) {
							continue;
						}
						const assignment = prop.asKind(SyntaxKind.PropertyAssignment);
						if (!assignment) {
							continue;
						}
						const initializer = assignment.getInitializer();
						if (initializer) {
							registeredProviders.add(initializer.getText());
						}
					}
				}
			}
		}

		// Scan all files for @Injectable() classes
		for (const filePath of context.files) {
			// Skip test files
			if (
				filePath.includes(".spec.") ||
				filePath.includes(".test.") ||
				filePath.includes("__test__") ||
				filePath.includes("__tests__")
			) {
				continue;
			}

			const sourceFile = context.project.getSourceFile(filePath);
			if (!sourceFile) {
				continue;
			}

			for (const cls of sourceFile.getClasses()) {
				const injectableDecorator = cls.getDecorator("Injectable");
				if (!injectableDecorator) {
					continue;
				}

				const className = cls.getName();
				if (!className) {
					continue;
				}

				// Skip infrastructure classes (guards, interceptors, etc.)
				if (INFRA_SUFFIXES.some((suffix) => className.endsWith(suffix))) {
					continue;
				}

				// Skip if registered in any module
				if (registeredProviders.has(className)) {
					continue;
				}

				context.report({
					filePath,
					message: `@Injectable() class '${className}' is not registered in any module's providers array.`,
					help: this.meta.help,
					line: cls.getStartLineNumber(),
					column: 1,
				});
			}
		}
	},
};
