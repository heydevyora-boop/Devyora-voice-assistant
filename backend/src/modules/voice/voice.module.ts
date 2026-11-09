import { Module } from '@nestjs/common';
import { SttModule } from '../../providers/stt/stt.module';
import { TtsModule } from '../../providers/tts/tts.module';
import { AssistantModule } from '../assistant/assistant.module';
import { AudioStoreService } from './audio/audio-store.service';
import { SttService } from './stt.service';
import { TtsService } from './tts.service';
import { VoiceEventBus } from './voice-event-bus';
import { VoiceGateway } from './voice.gateway';
import { VoiceSessionService } from './voice-session.service';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

@Module({
  imports: [SttModule, TtsModule, AssistantModule],
  controllers: [VoiceController],
  providers: [
    VoiceService,
    VoiceSessionService,
    SttService,
    TtsService,
    AudioStoreService,
    VoiceEventBus,
    VoiceGateway,
  ],
  exports: [VoiceService, VoiceSessionService, AudioStoreService, VoiceEventBus],
})
export class VoiceModule {}
