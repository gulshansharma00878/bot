import axios from 'axios';
import { TradeLog, Position } from '../utils/types';
import { logger } from '../utils/logger';
import { formatUsd, formatPercent } from '../utils/helpers';

export class NotificationService {
  private telegramBotToken: string;
  private telegramChatId: string;
  private discordWebhookUrl: string;
  private enabled: boolean;

  constructor(telegramBotToken: string, telegramChatId: string, discordWebhookUrl: string) {
    this.telegramBotToken = telegramBotToken;
    this.telegramChatId = telegramChatId;
    this.discordWebhookUrl = discordWebhookUrl;
    this.enabled = !!(telegramBotToken || discordWebhookUrl);
  }

  async notifyTradeOpen(position: Position): Promise<void> {
    const msg =
      `🟢 *TRADE OPENED*\n` +
      `Symbol: ${position.symbol}\n` +
      `Side: ${position.side.toUpperCase()}\n` +
      `Entry: ${formatUsd(position.entryPrice)}\n` +
      `Size: ${formatUsd(position.sizeUsd)}\n` +
      `Leverage: ${position.leverage}x\n` +
      `Stop Loss: ${formatUsd(position.stopLoss)}\n` +
      `Take Profit: ${formatUsd(position.takeProfit)}\n` +
      `Strategy: ${position.strategy}`;

    await this.send(msg);
  }

  async notifyTradeClose(position: Position, reason: string): Promise<void> {
    const emoji = position.realizedPnl >= 0 ? '🟢' : '🔴';
    const msg =
      `${emoji} *TRADE CLOSED* (${reason})\n` +
      `Symbol: ${position.symbol}\n` +
      `Side: ${position.side.toUpperCase()}\n` +
      `Entry: ${formatUsd(position.entryPrice)}\n` +
      `Exit: ${formatUsd(position.currentPrice)}\n` +
      `PnL: ${formatUsd(position.realizedPnl)}\n` +
      `Strategy: ${position.strategy}`;

    await this.send(msg);
  }

  async notifyAlert(title: string, message: string): Promise<void> {
    const msg = `⚠️ *${title}*\n${message}`;
    await this.send(msg);
  }

  async notifyDailySummary(
    capital: number,
    dailyPnl: number,
    openPositions: number,
    totalTrades: number
  ): Promise<void> {
    const msg =
      `📊 *DAILY SUMMARY*\n` +
      `Capital: ${formatUsd(capital)}\n` +
      `Daily PnL: ${formatUsd(dailyPnl)}\n` +
      `Open Positions: ${openPositions}\n` +
      `Total Trades: ${totalTrades}`;

    await this.send(msg);
  }

  private async send(message: string): Promise<void> {
    if (!this.enabled) return;

    const promises: Promise<void>[] = [];

    if (this.telegramBotToken && this.telegramChatId) {
      promises.push(this.sendTelegram(message));
    }

    if (this.discordWebhookUrl && !this.discordWebhookUrl.includes('your_webhook')) {
      promises.push(this.sendDiscord(message));
    }

    await Promise.allSettled(promises);
  }

  private async sendTelegram(message: string): Promise<void> {
    try {
      // Strip Markdown formatting and send as plain text to avoid 400 parse errors
      const plainText = message.replace(/\*/g, '');
      await axios.post(
        `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`,
        {
          chat_id: this.telegramChatId,
          text: plainText,
        },
        { timeout: 10000 }
      );
    } catch (error) {
      logger.error(`Telegram notification failed: ${error}`);
    }
  }

  private async sendDiscord(message: string): Promise<void> {
    try {
      // Convert markdown bold to Discord format and send
      const discordMsg = message.replace(/\*/g, '**');
      await axios.post(
        this.discordWebhookUrl,
        { content: discordMsg },
        { timeout: 10000 }
      );
    } catch (error) {
      logger.error(`Discord notification failed: ${error}`);
    }
  }
}
