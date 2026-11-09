import { Module } from '@nestjs/common';
import { LlmModule } from '../../providers/llm/llm.module';
import { SttModule } from '../../providers/stt/stt.module';
import { TtsModule } from '../../providers/tts/tts.module';
import { PushModule } from '../../providers/push/push.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [LlmModule, SttModule, TtsModule, PushModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
