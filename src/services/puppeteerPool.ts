import type { Browser, BrowserContext } from 'puppeteer';
import puppeteer from 'puppeteer';
import { logger } from '../utils/logger';

/**
 * Puppeteer browser pool.
 *
 * Browsers are pooled and reused. Contexts are created fresh per render
 * (not pooled) for complete isolation. Browsers restart after 100 renders
 * to prevent memory leaks.
 */
class PuppeteerPool {
  private browsers: Browser[] = [];
  private readonly poolSize: number;
  private readonly maxRendersPerBrowser = 100;
  private renderCounts: Map<Browser, number> = new Map();
  private isShuttingDown = false;

  constructor(poolSize: number = 3) {
    this.poolSize = poolSize;
  }

  async acquire(): Promise<BrowserContext> {
    if (this.isShuttingDown) {
      throw new Error('Puppeteer pool is shutting down');
    }

    let browser = this.browsers.find((b) => {
      const count = this.renderCounts.get(b) || 0;
      return count < this.maxRendersPerBrowser;
    });

    if (!browser && this.browsers.length < this.poolSize) {
      browser = await this.launchBrowser();
      this.browsers.push(browser);
      this.renderCounts.set(browser, 0);
    }

    if (!browser) {
      browser = this.browsers[0];
    }

    const renderCount = this.renderCounts.get(browser) || 0;

    if (renderCount >= this.maxRendersPerBrowser) {
      await this.restartBrowser(browser);
      browser =
        this.browsers[this.browsers.indexOf(browser)] || this.browsers[0];
    }

    const newCount = this.renderCounts.get(browser) || 0;
    this.renderCounts.set(browser, newCount + 1);

    const context = await browser.createBrowserContext();
    logger.debug(
      {
        poolSize: this.browsers.length,
        renderCount: newCount + 1,
      },
      'Browser context acquired',
    );

    return context;
  }

  async release(context: BrowserContext): Promise<void> {
    try {
      await context.close();
      logger.debug('Browser context released');
    } catch (error) {
      logger.error({ error }, 'Failed to close browser context');
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    logger.info('Shutting down Puppeteer pool');

    for (const browser of this.browsers) {
      try {
        await browser.close();
      } catch (error) {
        logger.error({ error }, 'Failed to close browser during shutdown');
      }
    }
    this.browsers = [];
    this.renderCounts.clear();

    logger.info('Puppeteer pool shut down');
  }

  private async launchBrowser(): Promise<Browser> {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--disable-gpu',
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });

    logger.info('Launched new Puppeteer browser');
    return browser;
  }

  private async restartBrowser(oldBrowser: Browser): Promise<void> {
    const index = this.browsers.indexOf(oldBrowser);
    if (index === -1) return;

    try {
      await oldBrowser.close();
    } catch (error) {
      logger.error({ error }, 'Failed to close old browser');
    }

    const newBrowser = await this.launchBrowser();
    this.browsers[index] = newBrowser;
    this.renderCounts.set(newBrowser, 0);
    this.renderCounts.delete(oldBrowser);

    logger.info('Restarted browser after reaching render limit');
  }
}

export const puppeteerPool = new PuppeteerPool(
  Number(process.env.PDF_POOL_SIZE) || 3,
);
