import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthRateLimitGuard } from '../../common/guards/auth-rate-limit.guard';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, RegisterDto, SocialLoginDto } from './dto/auth.dto';
import { AuthResponse, AuthTokensResponse } from './dto/auth-response.dto';

@ApiTags('auth')
@Controller('auth')
@UseGuards(AuthRateLimitGuard) // Apply rate limiting to all auth endpoints
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

  @ApiOperation({ summary: 'Login or Register via OAuth (Google, Facebook)' })
  @ApiOkResponse({ type: AuthResponse })
  @HttpCode(HttpStatus.OK)
  @Post('social')
  socialLogin(@Body() dto: SocialLoginDto) {
    return this.auth.socialLogin(dto);
  }

  @ApiOperation({ summary: 'Refresh tokens' })
  @ApiOkResponse({ type: AuthTokensResponse })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto);
  }

  @ApiOperation({
    summary: 'Logout: revoke every session of the refresh token owner (LEGACY-451)',
  })
  @ApiOkResponse({ schema: { properties: { success: { type: 'boolean', example: true } } } })
  @ApiUnauthorizedResponse({ description: 'Refresh token is malformed, forged or expired' })
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto);
  }
}
