import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { mikroOrmConfig } from './mikro-orm.config.js';
import { HealthController } from './health.controller.js';

@Module({
  // Register the shared database connection once for injection across NestJS providers.
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
