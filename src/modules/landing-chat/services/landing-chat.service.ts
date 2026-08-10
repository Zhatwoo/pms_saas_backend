import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QUICKPAWN_LANDING_ASSISTANT_PROMPT } from '../prompts/quickpawn-assistant.prompt';
import type { LandingChatHistoryMessageDto } from '../dto/landing-chat.dto';

type GroqChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type GroqChatResponse = {
  choices?: Array<{
    message?: { content?: string };
  }>;
  error?: { message?: string };
};

@Injectable()
export class LandingChatService {
  private readonly logger = new Logger(LandingChatService.name);

  constructor(private readonly config: ConfigService) {}

  async reply(
    message: string,
    history: LandingChatHistoryMessageDto[] = [],
  ): Promise<{ reply: string }> {
    const apiKey = this.config.get<string>('GROQ_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Chat assistant is not configured yet. Please use the Contact form or email us directly.',
      );
    }

    const model =
      this.config.get<string>('GROQ_MODEL')?.trim() ||
      'llama-3.3-70b-versatile';

    const trimmedMessage = message.trim();
    const safeHistory = history
      .filter(
        (entry) =>
          (entry.role === 'user' || entry.role === 'assistant') &&
          typeof entry.content === 'string' &&
          entry.content.trim().length > 0,
      )
      .slice(-10)
      .map(
        (entry): GroqChatMessage => ({
          role: entry.role,
          content: entry.content.trim().slice(0, 2000),
        }),
      );

    const messages: GroqChatMessage[] = [
      { role: 'system', content: QUICKPAWN_LANDING_ASSISTANT_PROMPT },
      ...safeHistory,
      { role: 'user', content: trimmedMessage },
    ];

    let response: Response;
    try {
      response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.4,
            max_tokens: 700,
          }),
          signal: AbortSignal.timeout(25_000),
        },
      );
    } catch (err) {
      this.logger.error('Groq request failed', err);
      throw new BadGatewayException(
        'The assistant is temporarily unavailable. Please try again or use the Contact form.',
      );
    }

    const payload = (await response.json()) as GroqChatResponse;

    if (!response.ok) {
      this.logger.warn(
        `Groq API error ${response.status}: ${payload.error?.message ?? 'unknown'}`,
      );
      throw new BadGatewayException(
        'The assistant could not respond right now. Please try again shortly.',
      );
    }

    const reply = payload.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new BadGatewayException(
        'Empty response from assistant. Please try again.',
      );
    }

    return { reply };
  }
}
