import { Module } from "@nestjs/common";
import { HealthCron } from "./health.cron";
import { HealthService } from "./health.service";
import { UnusedService } from "./unused.service";

@Module({
	providers: [HealthCron, HealthService, UnusedService],
})
export class AppModule {}
