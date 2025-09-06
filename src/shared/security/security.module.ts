import { Global, Module } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [RolesGuard, JwtAuthGuard],
  exports: [RolesGuard, JwtAuthGuard],
})
export class SecurityModule {}
