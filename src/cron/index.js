import cron from 'node-cron';
import * as Sentry from '@sentry/node';
import { checkTimeouts } from './timeout-checker.js';
import { refreshInstagramTokens } from './instagram-token-refresh.js';
import { 
  processOverdueTransactions, 
  generateRecurringTransactions,
  processDailyFinancialJobs 
} from './financial-jobs.js';
import { processScheduledNotifications } from '../controllers/schedules/scheduleNotifications.js';

/**
 * Configura todos os cron jobs da aplicação
 */
export const setupCronJobs = () => {
  try {
    // Verifica timeouts a cada minuto
    const timeoutCron = cron.schedule('* * * * *', async () => {
      try {
        await checkTimeouts();
      } catch (error) {
        Sentry.captureException(error);
      }
    });
    
    // Atualiza tokens do Instagram todos os dias à meia-noite
    const instagramTokenCron = cron.schedule('0 0 * * *', async () => {
      try {
        await refreshInstagramTokens();
      } catch (error) {
        console.error('Error refreshing Instagram tokens:', error);
        Sentry.captureException(error);
      }
    });

    // Job para processar transações vencidas (executa diariamente às 00:30)
    const overdueTransactionsCron = cron.schedule('30 0 * * *', async () => {
      try {
        await processOverdueTransactions();
      } catch (error) {
        console.error('Erro ao processar transações vencidas:', error);
        Sentry.captureException(error);
      }
    });

    // Job para gerar transações recorrentes (executa diariamente às 01:00)
    const recurringTransactionsCron = cron.schedule('0 1 * * *', async () => {
      try {
        await generateRecurringTransactions();
      } catch (error) {
        console.error('Erro ao gerar transações recorrentes:', error);
        Sentry.captureException(error);
      }
    });

    // Job para processar todas as tarefas financeiras diárias (executa às 02:00)
    const dailyFinancialJobsCron = cron.schedule('0 2 * * *', async () => {
      try {
        await processDailyFinancialJobs();
      } catch (error) {
        console.error('Erro ao processar jobs financeiros diários:', error);
        Sentry.captureException(error);
      }
    });
    
    // Job para verificar e enviar notificações programadas (executa a cada 5 minutos)
    const notificationsCron = cron.schedule('*/5 * * * *', async () => {
      try {
        // console.log('[CRON] Iniciando verificação de notificações programadas...');
        const result = await processScheduledNotifications();
        // console.log(`[CRON] Processamento de notificações concluído: ${result.appointments_processed} agendamentos processados, ${result.reminders_created} lembretes criados`);
      } catch (error) {
        console.error('Erro ao verificar notificações programadas:', error);
        Sentry.captureException(error);
      }
    });
    
    // Retorna os cron jobs para que possam ser parados se necessário
    return {
      timeoutCron,
      instagramTokenCron,
      overdueTransactionsCron,
      recurringTransactionsCron,
      dailyFinancialJobsCron,
      notificationsCron
    };
  } catch (error) {
    Sentry.captureException(error);
    console.error('Erro ao configurar cron jobs:', error);
    return {};
  }
}; 