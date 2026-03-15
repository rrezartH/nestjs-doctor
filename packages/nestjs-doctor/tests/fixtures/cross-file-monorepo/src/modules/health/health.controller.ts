import { Controller, Get, UseGuards } from "@nestjs/common";
import type { HealthService } from "./health.service";

// Empty @UseGuards(): intentional for testing decorator detection
@UseGuards()
@Controller("health")
export class HealthController {
	constructor(private readonly healthService: HealthService) {}

	@Get()
	check() {
		return this.healthService.check();
	}
}
