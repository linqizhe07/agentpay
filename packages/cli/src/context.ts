import { Ledger, MandateWallet } from '@agentpay/wallet';
import { requireKey, type CliConfig } from './config.js';

/**
 * What the wallet has to say about its files (a torn ledger tail it dropped,
 * counters it rebuilt from the ledger) goes to stderr: stdout stays the one
 * JSON document the CLI contract promises, and the operator still gets a trace.
 */
const stderrLog = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Lazily-built dependencies shared by the command handlers. */
export class CommandContext {
  private walletInstance?: MandateWallet;
  private ledgerInstance?: Ledger;

  constructor(
    public readonly config: CliConfig,
    public readonly fetch: typeof globalThis.fetch = globalThis.fetch,
    private readonly log: (line: string) => void = stderrLog,
  ) {}

  /** The payer wallet; requires a private key. */
  wallet(): MandateWallet {
    if (!this.walletInstance) {
      this.walletInstance = new MandateWallet({
        key: requireKey(this.config),
        rpcUrl: this.config.rpcUrl,
        token: this.config.token,
        assetDomain: this.config.tokenDomain,
        network: this.config.network,
        mandatesPath: this.config.mandatesPath,
        ledgerPath: this.config.ledgerPath,
        fetch: this.fetch,
        log: this.log,
      });
    }
    return this.walletInstance;
  }

  ledger(): Ledger {
    if (!this.ledgerInstance) this.ledgerInstance = new Ledger(this.config.ledgerPath, this.log);
    return this.ledgerInstance;
  }
}
