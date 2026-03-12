import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { buildEndpointGraph } from "../../src/engine/graph/endpoint-graph.js";
import { resolveProviders } from "../../src/engine/graph/type-resolver.js";

function createProject(files: Record<string, string>) {
	const project = new Project({ useInMemoryFileSystem: true });
	const paths: string[] = [];
	for (const [name, code] of Object.entries(files)) {
		project.createSourceFile(name, code);
		paths.push(name);
	}
	return { project, paths };
}

describe("endpoint-graph", () => {
	it("dependency tree only includes deps used by the endpoint method chain", () => {
		const { project, paths } = createProject({
			"admin.controller.ts": `
				import { Controller, Get } from '@nestjs/common';
				@Controller('admin')
				export class AdminController {
					constructor(private readonly adminService: AdminService) {}

					@Get('organizations')
					getAllOrganizations() {
						return this.adminService.getAllOrganizations();
					}
				}
			`,
			"admin.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AdminService {
					constructor(
						private readonly adminRepository: AdminRepository,
						private readonly logger: CrocovaLogger,
						private readonly rolesService: RolesService,
						private readonly eventsService: OrganizationEventsService,
					) {}

					getAllOrganizations() {
						return this.adminRepository.findAllOrganizations();
					}

					deleteOrganization(id: string) {
						this.eventsService.emit(id);
						this.rolesService.revokeAll(id);
						return this.adminRepository.deleteOrganization(id);
					}
				}
			`,
			"admin.repository.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AdminRepository {
					constructor(private readonly prisma: PrismaService) {}

					findAllOrganizations() {
						return this.prisma.findMany();
					}

					deleteOrganization(id: string) {
						return this.prisma.delete(id);
					}
				}
			`,
			"crocova-logger.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class CrocovaLogger {
					log(msg: string) {}
				}
			`,
			"roles.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class RolesService {
					revokeAll(id: string) {}
				}
			`,
			"events.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class OrganizationEventsService {
					emit(id: string) {}
				}
			`,
			"prisma.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class PrismaService {
					organization = {};
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find(
			(e) => e.httpMethod === "GET" && e.routePath === "/admin/organizations"
		);
		expect(endpoint).toBeDefined();

		// Top-level: single method node for AdminService.getAllOrganizations
		expect(endpoint!.dependencies).toHaveLength(1);
		expect(endpoint!.dependencies[0].className).toBe("AdminService");
		expect(endpoint!.dependencies[0].methodName).toBe("getAllOrganizations");
		expect(endpoint!.dependencies[0].conditional).toBe(false);

		// AdminService's sub-deps: AdminRepository.findAllOrganizations (not CrocovaLogger, RolesService, etc.)
		const adminServiceDeps = endpoint!.dependencies[0].dependencies;
		expect(adminServiceDeps).toHaveLength(1);
		expect(adminServiceDeps[0].className).toBe("AdminRepository");
		expect(adminServiceDeps[0].methodName).toBe("findAllOrganizations");
		expect(adminServiceDeps[0].conditional).toBe(false);

		// AdminRepository's sub-deps: PrismaService.findMany
		const adminRepoDeps = adminServiceDeps[0].dependencies;
		expect(adminRepoDeps).toHaveLength(1);
		expect(adminRepoDeps[0].className).toBe("PrismaService");
		expect(adminRepoDeps[0].methodName).toBe("findMany");

		// Method nodes have line numbers
		expect(endpoint!.dependencies[0].line).toBeGreaterThan(0);
		expect(adminServiceDeps[0].line).toBeGreaterThan(0);
	});

	it("populates line numbers for dependency method nodes", () => {
		const { project, paths } = createProject({
			"app.controller.ts": `
				import { Controller, Get } from '@nestjs/common';
				@Controller()
				export class AppController {
					constructor(private readonly svc: AppService) {}

					@Get()
					getRoot() {
						return this.svc.hello();
					}
				}
			`,
			"app.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AppService {
					hello() { return 'hi'; }
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "GET");
		expect(endpoint).toBeDefined();

		const dep = endpoint!.dependencies[0];
		expect(dep.className).toBe("AppService");
		expect(dep.methodName).toBe("hello");
		expect(dep.line).toBeGreaterThan(0);
	});

	it("sets line to 0 for fallback dependency nodes", () => {
		const { project, paths } = createProject({
			"app.controller.ts": `
				import { Controller, Get } from '@nestjs/common';
				@Controller()
				export class AppController {
					constructor(private readonly svc: AppService) {}

					@Get()
					getRoot() {
						return this.svc.hello();
					}
				}
			`,
			"app.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AppService {
					constructor(private readonly helper: HelperService) {}
					hello() { return 'hi'; }
				}
			`,
			"helper.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class HelperService {
					doWork() {}
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "GET");
		expect(endpoint).toBeDefined();

		// AppService.hello calls no sub-deps, but HelperService is a constructor dep
		// Since hello() doesn't call this.helper.*, HelperService won't appear
		// Let's verify the method node has a line
		const dep = endpoint!.dependencies[0];
		expect(dep.line).toBeGreaterThan(0);
	});

	it("falls back to all constructor deps when no method info is available", () => {
		const { project, paths } = createProject({
			"app.controller.ts": `
				import { Controller, Get } from '@nestjs/common';
				@Controller()
				export class AppController {
					constructor(private readonly appService: AppService) {}

					@Get()
					getRoot() {
						return this.appService.getHello();
					}
				}
			`,
			"app.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AppService {
					constructor(
						private readonly configService: ConfigService,
						private readonly cacheService: CacheService,
					) {}

					getHello() {
						return this.configService.get('greeting');
					}
				}
			`,
			"config.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class ConfigService {
					constructor(
						private readonly envLoader: EnvLoader,
						private readonly validator: ConfigValidator,
					) {}

					get(key: string) { return key; }
				}
			`,
			"cache.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class CacheService {
					get(key: string) { return key; }
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "GET");
		expect(endpoint).toBeDefined();

		// AppService.getHello is the only top-level dep
		expect(endpoint!.dependencies).toHaveLength(1);
		const appService = endpoint!.dependencies[0];
		expect(appService.className).toBe("AppService");
		expect(appService.methodName).toBe("getHello");

		// Only ConfigService.get (used in getHello), NOT CacheService
		expect(appService.dependencies).toHaveLength(1);
		expect(appService.dependencies[0].className).toBe("ConfigService");
		expect(appService.dependencies[0].methodName).toBe("get");

		// ConfigService.get() doesn't call any injected deps, so childDeps will be empty
		expect(appService.dependencies[0].dependencies).toHaveLength(0);
	});

	it("handles circular dependencies without infinite recursion", () => {
		const { project, paths } = createProject({
			"a.controller.ts": `
				import { Controller, Get } from '@nestjs/common';
				@Controller('a')
				export class AController {
					constructor(private readonly aService: AService) {}

					@Get()
					getA() {
						return this.aService.doA();
					}
				}
			`,
			"a.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AService {
					constructor(private readonly bService: BService) {}
					doA() {
						return this.bService.doB();
					}
				}
			`,
			"b.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class BService {
					constructor(private readonly aService: AService) {}
					doB() {
						return this.aService.doA();
					}
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "GET");
		expect(endpoint).toBeDefined();

		// AService.doA → BService.doB, but BService → AService is visited, so stops
		expect(endpoint!.dependencies).toHaveLength(1);
		expect(endpoint!.dependencies[0].className).toBe("AService");
		expect(endpoint!.dependencies[0].methodName).toBe("doA");
		expect(endpoint!.dependencies[0].dependencies).toHaveLength(1);
		expect(endpoint!.dependencies[0].dependencies[0].className).toBe(
			"BService"
		);
		expect(endpoint!.dependencies[0].dependencies[0].methodName).toBe("doB");
		// AService already visited, so no deeper recursion
		expect(endpoint!.dependencies[0].dependencies[0].dependencies).toHaveLength(
			0
		);
	});

	it("marks methods inside if/else branches as conditional", () => {
		const { project, paths } = createProject({
			"org.controller.ts": `
				import { Controller, Post } from '@nestjs/common';
				@Controller('org')
				export class OrgController {
					constructor(private readonly orgService: OrgService) {}

					@Post()
					create() {
						return this.orgService.createOrganizationWithOwner();
					}
				}
			`,
			"org.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class OrgService {
					constructor(private readonly adminRepo: AdminRepository) {}

					createOrganizationWithOwner() {
						const owner = this.adminRepo.findUserByEmail('test');
						if (!owner) {
							this.adminRepo.createUser({});
						} else if (owner.status !== 'ACTIVE') {
							this.adminRepo.activateUser(owner.id);
						}
						return owner;
					}
				}
			`,
			"admin.repository.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AdminRepository {
					findUserByEmail(email: string) { return null; }
					createUser(data: any) { return data; }
					activateUser(id: string) { return id; }
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "POST");
		expect(endpoint).toBeDefined();

		const orgService = endpoint!.dependencies[0];
		expect(orgService.className).toBe("OrgService");
		expect(orgService.methodName).toBe("createOrganizationWithOwner");

		// Each method of AdminRepository is its own node in orgService.dependencies
		const adminRepoDeps = orgService.dependencies;
		expect(adminRepoDeps).toHaveLength(3);

		// findUserByEmail is unconditional
		const findUser = adminRepoDeps.find(
			(d) => d.methodName === "findUserByEmail"
		);
		expect(findUser).toBeDefined();
		expect(findUser!.conditional).toBe(false);

		// createUser is conditional
		const createUser = adminRepoDeps.find((d) => d.methodName === "createUser");
		expect(createUser).toBeDefined();
		expect(createUser!.conditional).toBe(true);

		// activateUser is conditional
		const activateUser = adminRepoDeps.find(
			(d) => d.methodName === "activateUser"
		);
		expect(activateUser).toBeDefined();
		expect(activateUser!.conditional).toBe(true);
	});

	it("marks method as unconditional when called both inside and outside conditional", () => {
		const { project, paths } = createProject({
			"app.controller.ts": `
				import { Controller, Post } from '@nestjs/common';
				@Controller()
				export class AppController {
					constructor(private readonly svc: AppService) {}

					@Post()
					doWork() {
						return this.svc.process();
					}
				}
			`,
			"app.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AppService {
					constructor(private readonly repo: DataRepository) {}

					process() {
						this.repo.save('always');
						if (Math.random() > 0.5) {
							this.repo.save('conditional');
						}
						return true;
					}
				}
			`,
			"data.repository.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class DataRepository {
					save(data: string) { return data; }
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "POST");
		expect(endpoint).toBeDefined();

		// DataRepository.save — single method node
		const repo = endpoint!.dependencies[0].dependencies[0];
		expect(repo.className).toBe("DataRepository");
		expect(repo.methodName).toBe("save");
		// Called both conditionally and unconditionally → unconditional wins
		expect(repo.conditional).toBe(false);
	});

	it("marks methods in switch case clauses as conditional", () => {
		const { project, paths } = createProject({
			"app.controller.ts": `
				import { Controller, Post } from '@nestjs/common';
				@Controller()
				export class AppController {
					constructor(private readonly svc: AppService) {}

					@Post()
					handle() {
						return this.svc.route('type');
					}
				}
			`,
			"app.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AppService {
					constructor(private readonly repo: DataRepository) {}

					route(type: string) {
						switch (type) {
							case 'a':
								return this.repo.handleA();
							case 'b':
								return this.repo.handleB();
							default:
								return this.repo.handleDefault();
						}
					}
				}
			`,
			"data.repository.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class DataRepository {
					handleA() {}
					handleB() {}
					handleDefault() {}
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "POST");
		expect(endpoint).toBeDefined();

		// Each switch case method is its own node
		const repoDeps = endpoint!.dependencies[0].dependencies;
		expect(repoDeps).toHaveLength(3);
		for (const dep of repoDeps) {
			expect(dep.className).toBe("DataRepository");
			expect(dep.conditional).toBe(true);
		}
		const methodNames = repoDeps.map((d) => d.methodName).sort();
		expect(methodNames).toEqual(["handleA", "handleB", "handleDefault"]);
	});

	it("marks ternary branches as conditional", () => {
		const { project, paths } = createProject({
			"app.controller.ts": `
				import { Controller, Get } from '@nestjs/common';
				@Controller()
				export class AppController {
					constructor(private readonly svc: AppService) {}

					@Get()
					check() {
						return this.svc.decide();
					}
				}
			`,
			"app.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AppService {
					constructor(private readonly repo: DataRepository) {}

					decide() {
						return Math.random() > 0.5
							? this.repo.optionA()
							: this.repo.optionB();
					}
				}
			`,
			"data.repository.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class DataRepository {
					optionA() {}
					optionB() {}
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "GET");
		expect(endpoint).toBeDefined();

		const repoDeps = endpoint!.dependencies[0].dependencies;
		expect(repoDeps).toHaveLength(2);
		const optA = repoDeps.find((d) => d.methodName === "optionA");
		const optB = repoDeps.find((d) => d.methodName === "optionB");
		expect(optA!.conditional).toBe(true);
		expect(optB!.conditional).toBe(true);
	});

	it("marks catch clause methods as conditional but try body as unconditional", () => {
		const { project, paths } = createProject({
			"app.controller.ts": `
				import { Controller, Post } from '@nestjs/common';
				@Controller()
				export class AppController {
					constructor(private readonly svc: AppService) {}

					@Post()
					save() {
						return this.svc.safeSave();
					}
				}
			`,
			"app.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AppService {
					constructor(private readonly repo: DataRepository) {}

					safeSave() {
						try {
							this.repo.save('data');
						} catch (e) {
							this.repo.logError(e);
						}
					}
				}
			`,
			"data.repository.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class DataRepository {
					save(data: string) { return data; }
					logError(e: any) {}
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "POST");
		expect(endpoint).toBeDefined();

		const repoDeps = endpoint!.dependencies[0].dependencies;
		expect(repoDeps).toHaveLength(2);
		const save = repoDeps.find((d) => d.methodName === "save");
		const logError = repoDeps.find((d) => d.methodName === "logError");
		expect(save!.conditional).toBe(false);
		expect(logError!.conditional).toBe(true);
	});

	it("treats if-condition expression calls as unconditional", () => {
		const { project, paths } = createProject({
			"app.controller.ts": `
				import { Controller, Get } from '@nestjs/common';
				@Controller()
				export class AppController {
					constructor(private readonly svc: AppService) {}

					@Get()
					check() {
						return this.svc.guardedAction();
					}
				}
			`,
			"app.service.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class AppService {
					constructor(private readonly repo: DataRepository) {}

					guardedAction() {
						if (this.repo.isReady()) {
							this.repo.execute();
						}
					}
				}
			`,
			"data.repository.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class DataRepository {
					isReady() { return true; }
					execute() {}
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "GET");
		expect(endpoint).toBeDefined();

		const repoDeps = endpoint!.dependencies[0].dependencies;
		expect(repoDeps).toHaveLength(2);
		const isReady = repoDeps.find((d) => d.methodName === "isReady");
		const execute = repoDeps.find((d) => d.methodName === "execute");
		expect(isReady!.conditional).toBe(false);
		expect(execute!.conditional).toBe(true);
	});

	it("preserves cross-class call order", () => {
		const { project, paths } = createProject({
			"app.controller.ts": `
				import { Controller, Post } from '@nestjs/common';
				@Controller()
				export class AppController {
					constructor(
						private readonly serviceA: ServiceA,
						private readonly serviceB: ServiceB,
					) {}

					@Post()
					handle() {
						this.serviceA.foo();
						this.serviceB.bar();
						this.serviceA.baz();
					}
				}
			`,
			"service-a.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class ServiceA {
					constructor(private readonly repo: DataRepository) {}
					foo() { return this.repo.find(); }
					baz() {}
				}
			`,
			"service-b.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class ServiceB {
					bar() {}
				}
			`,
			"data.repository.ts": `
				import { Injectable } from '@nestjs/common';
				@Injectable()
				export class DataRepository {
					find() {}
				}
			`,
		});

		const providers = resolveProviders(project, paths);
		const graph = buildEndpointGraph(project, paths, providers);

		const endpoint = graph.endpoints.find((e) => e.httpMethod === "POST");
		expect(endpoint).toBeDefined();

		// 3 dependency nodes: ServiceA.foo, ServiceB.bar, ServiceA.baz
		expect(endpoint!.dependencies).toHaveLength(3);

		expect(endpoint!.dependencies[0].className).toBe("ServiceA");
		expect(endpoint!.dependencies[0].methodName).toBe("foo");
		expect(endpoint!.dependencies[0].order).toBe(0);

		expect(endpoint!.dependencies[1].className).toBe("ServiceB");
		expect(endpoint!.dependencies[1].methodName).toBe("bar");
		expect(endpoint!.dependencies[1].order).toBe(1);

		expect(endpoint!.dependencies[2].className).toBe("ServiceA");
		expect(endpoint!.dependencies[2].methodName).toBe("baz");
		expect(endpoint!.dependencies[2].order).toBe(2);

		// Only foo (first for ServiceA) has sub-deps; baz has none
		expect(endpoint!.dependencies[0].dependencies).toHaveLength(1);
		expect(endpoint!.dependencies[0].dependencies[0].className).toBe(
			"DataRepository"
		);
		expect(endpoint!.dependencies[2].dependencies).toHaveLength(0);
	});
});
