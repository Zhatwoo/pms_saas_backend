import { Module } from '@nestjs/common';
import { DevicesController } from './controllers/devices.controller';
import { DevicesService } from './services/devices.service';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
