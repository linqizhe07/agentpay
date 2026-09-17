import { Ledger, MandateWallet } from '@agentpay/wallet';
import { requireKey, type CliConfig } from './config.js';

/** Lazily-built dependencies shared by the command handlers. */
export class CommandContext {
  private walletInstance?: MandateWallet;
  private ledgerInstance?: Ledger;

  constructor(
    public readonly config: CliConfig,
    public readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  /** The payer wallet; requires a private key. */
  wallet(): MandateWallet {
    if (!this.walletInstance) {
      this.walletInstance = new MandateWallet({
        key: requireKey(this.config),
        rpcUrl: this.config.rpcUrl,
        walletContract: this.config.walletContract,
        token: this.config.token,
        network: this.config.network,
        trustedSps: this.config.trustedSps.length > 0 ? this.config.trustedSps : undefined,
        mandatesPath: this.config.mandatesPath,
        ledgerPath: this.config.ledgerPath,
        fetch: this.fetch,
      });
    }
    return this.walletInstance;
  }

  ledger(): Ledger {
    if (!this.ledgerInstance) this.ledgerInstance = new Ledger(this.config.ledgerPath);
    return this.ledgerInstance;
  }
}
