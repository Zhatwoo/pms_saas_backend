
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { BranchesService } from '../src/modules/branches/services/branches.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const branchesService = app.get(BranchesService);
  const branches = await branchesService.findAll();
  
  console.log('--- Branch Codes ---');
  branches.forEach(b => {
    console.log(`${b.name}: ${b.branch_code} (ID: ${b.id})`);
  });
  
  await app.close();
}

bootstrap().catch(err => {
  console.error(err);
  process.exit(1);
});
