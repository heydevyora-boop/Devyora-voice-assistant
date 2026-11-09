import { Module } from '@nestjs/common';
import { LlmModule } from '../../providers/llm/llm.module';
import { AiService } from './ai.service';

@Module({
  imports: [LlmModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
