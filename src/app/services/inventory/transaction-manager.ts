import { WritableSignal } from '@angular/core';
import { TransactionRecord } from '../../types/coin.model';
import { ApiService, describeHttpError } from '../api.service';
import { LoggingService } from '../logging.service';
import { NotificationService } from '../notification.service';
import { firstValueFrom } from 'rxjs';

/* ===========================================================================
 * TransactionManager
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   The buy/sell history rows attached to coins: adding one, deleting one,
 *   and clearing out a deleted coin's history.
 *
 * WHY IT IS ITS OWN FILE
 *   Transactions are a separate table with their own endpoints; they only
 *   relate to coins through `coinId`. Keeping them here means the coin code
 *   never has to think about them beyond "this coin is gone, drop its rows".
 *
 * The `transactions` signal belongs to InventoryService (it is public API);
 * this class is handed that same signal to read and write.
 * =========================================================================== */

export class TransactionManager {
  constructor(
    private readonly transactions: WritableSignal<TransactionRecord[]>,
    private readonly apiService: ApiService,
    private readonly logger: LoggingService,
    private readonly notificationService: NotificationService
  ) {}

  addTransaction(txn: TransactionRecord): void {
    this.transactions.set([...this.transactions(), txn]);

    firstValueFrom(this.apiService.createTransaction(txn))
      .then(() => this.logger.info(`Created transaction ${txn.id} in database`))
      .catch((error) => {
        this.logger.error(`Failed to create transaction in database`, describeHttpError(error));
        this.notificationService.showError('Failed to save transaction to database');
      });
  }

  deleteTransaction(txnId: string): void {
    this.transactions.set(this.transactions().filter(t => t.id !== txnId));

    firstValueFrom(this.apiService.deleteTransaction(txnId))
      .then(() => this.logger.info(`Deleted transaction ${txnId} from database`))
      .catch((error) => {
        this.logger.error(`Failed to delete transaction from database`, describeHttpError(error));
        this.notificationService.showError('Failed to delete transaction from database');
      });
  }

  /**
   * Drop every transaction belonging to a coin that has just been deleted.
   *
   * Local only: the server removes the rows itself as part of deleting the
   * coin, so there is no extra request to make here.
   */
  removeForCoin(coinId: string): void {
    this.transactions.set(this.transactions().filter(t => t.coinId !== coinId));
  }
}
