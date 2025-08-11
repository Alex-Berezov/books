import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, RegisterDto } from './dto/auth.dto';

class AuthUserResponse {
  id!: string;
  email!: string;
  name?: string | null;
  avatarUrl?: string | null;
  languagePreference!: string;
  createdAt!: Date;
  lastLogin?: Date | null;
}

class AuthResponse {
  user!: AuthUserResponse;
  accessToken!: string;
  refreshToken!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @ApiOperation({ summary: 'Register new user' })
  @ApiCreatedResponse({ type: AuthResponse })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @ApiOperation({ summary: 'Login by email/password' })
  @ApiOkResponse({ type: AuthResponse })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @ApiOperation({ summary: 'Refresh tokens' })
  @ApiOkResponse({ type: AuthResponse })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto);
  }

  @ApiOperation({ summary: 'Logout (stateless placeholder)' })
  @ApiOkResponse({ schema: { properties: { success: { type: 'boolean', example: true } } } })
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout() {
    return this.auth.logout();
  }
}
