import { Controller, Get, UseGuards } from "@nestjs/common";
import type { AppService } from "./app.service";

// Empty @UseGuards(): intentional for testing decorator detection
@UseGuards()
@Controller()
export class AppController {
	constructor(private readonly appService: AppService) {}

	@Get()
	getStatus() {
		return this.appService.getStatus();
	}
}
