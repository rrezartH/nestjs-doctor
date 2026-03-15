import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import type { AdminAuthService } from "./admin-auth.service";

// Empty @UseGuards(): intentional for testing decorator detection
@UseGuards()
@Controller("admin/auth")
export class AdminAuthController {
	constructor(private readonly adminAuthService: AdminAuthService) {}

	@Get("validate/:token")
	validate(@Param("token") token: string) {
		return this.adminAuthService.validate(token);
	}
}
