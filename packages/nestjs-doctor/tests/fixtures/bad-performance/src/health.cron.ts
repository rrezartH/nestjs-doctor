import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { HealthService } from "./health.service";

@Injectable()
export class HealthCron {
	constructor(private readonly healthService: HealthService) {}

	@Cron("0 */5 * * * *")
	async handleCron() {
		await this.healthService.check();
	}
}
