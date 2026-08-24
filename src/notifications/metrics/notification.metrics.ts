import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, register } from 'prom-client';

@Injectable()
export class NotificationMetricsService {
  // Counters
  private notificationsCreated: Counter;
  private notificationsSent: Counter;
  private notificationsFailed: Counter;
  private notificationsRetried: Counter;
  
  // Gauges
  private queueDepth: Gauge;
  private connectedUsers: Gauge;
  
  // Histograms
  private processingLatency: Histogram;
  private deliveryLatency: Histogram;

  constructor() {
    this.initializeMetrics();
  }

  private initializeMetrics() {
    // Notifications created counter
    this.notificationsCreated = new Counter({
      name: 'notifications_created_total',
      help: 'Total number of notifications created',
      labelNames: ['type'],
    });

    // Notifications sent counter
    this.notificationsSent = new Counter({
      name: 'notifications_sent_total',
      help: 'Total number of notifications successfully delivered',
      labelNames: ['channel', 'type'],
    });

    // Notifications failed counter
    this.notificationsFailed = new Counter({
      name: 'notifications_failed_total',
      help: 'Total number of notifications that failed delivery',
      labelNames: ['channel', 'type', 'reason'],
    });

    // Notifications retried counter
    this.notificationsRetried = new Counter({
      name: 'notifications_retried_total',
      help: 'Total number of notification delivery retries',
      labelNames: ['channel'],
    });

    // Queue depth gauge
    this.queueDepth = new Gauge({
      name: 'notifications_queue_depth',
      help: 'Current number of notifications waiting in the queue',
      labelNames: ['queue'],
    });

    // Connected users gauge
    this.connectedUsers = new Gauge({
      name: 'notifications_connected_users',
      help: 'Number of users currently connected via WebSocket',
    });

    // Processing latency histogram
    this.processingLatency = new Histogram({
      name: 'notifications_processing_latency_seconds',
      help: 'Time taken to process and queue a notification',
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
    });

    // Delivery latency histogram
    this.deliveryLatency = new Histogram({
      name: 'notifications_delivery_latency_seconds',
      help: 'Time taken to deliver a notification after queuing',
      buckets: [0.1, 0.5, 1, 5, 10, 30],
    });

    // Register all metrics
    register.registerMetric(this.notificationsCreated);
    register.registerMetric(this.notificationsSent);
    register.registerMetric(this.notificationsFailed);
    register.registerMetric(this.notificationsRetried);
    register.registerMetric(this.queueDepth);
    register.registerMetric(this.connectedUsers);
    register.registerMetric(this.processingLatency);
    register.registerMetric(this.deliveryLatency);
  }

  // Increment notifications created
  incrementCreated(type: string) {
    this.notificationsCreated.inc({ type });
  }

  // Increment notifications sent
  incrementSent(channel: string, type: string) {
    this.notificationsSent.inc({ channel, type });
  }

  // Increment notifications failed
  incrementFailed(channel: string, type: string, reason: string) {
    this.notificationsFailed.inc({ channel, type, reason });
  }

  // Increment retries
  incrementRetried(channel: string) {
    this.notificationsRetried.inc({ channel });
  }

  // Update queue depth
  setQueueDepth(queue: string, depth: number) {
    this.queueDepth.set({ queue }, depth);
  }

  // Update connected users count
  setConnectedUsers(count: number) {
    this.connectedUsers.set(count);
  }

  // Observe processing latency
  observeProcessingLatency(duration: number) {
    this.processingLatency.observe(duration);
  }

  // Observe delivery latency
  observeDeliveryLatency(duration: number) {
    this.deliveryLatency.observe(duration);
  }

  // Get all metrics for Prometheus scraping
  async getMetrics() {
    return register.metrics();
  }
}