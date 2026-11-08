import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global so repositories can inject the client without every feature module
 * re-importing it. The client is a single pooled connection per process;
 * there is nothing to isolate per module.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
