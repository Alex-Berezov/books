import { Test, TestingModule } from '@nestjs/testing';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ContributorsController } from './contributors.controller';
import { ContributorsService } from './contributors.service';
import { ContributorIdentityConfidenceDto, ContributorRoleDto } from './dto/create-contributor.dto';

describe('ContributorsController', () => {
  let controller: ContributorsController;
  let service: Record<string, jest.Mock>;

  const mockContributor = {
    id: 'contributor-1',
    displayName: 'Homer',
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn().mockResolvedValue({ items: [mockContributor], total: 1 }),
      create: jest.fn().mockResolvedValue(mockContributor),
      findOne: jest.fn().mockResolvedValue(mockContributor),
      update: jest.fn().mockResolvedValue({ ...mockContributor, displayName: 'Homer 2' }),
      remove: jest.fn().mockResolvedValue(mockContributor),
      linkSourceEdition: jest.fn().mockResolvedValue({ id: 'sec-1' }),
      unlinkSourceEdition: jest.fn().mockResolvedValue({ id: 'sec-1' }),
      linkRightsComponent: jest.fn().mockResolvedValue({ id: 'rcc-1' }),
      unlinkRightsComponent: jest.fn().mockResolvedValue({ id: 'rcc-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContributorsController],
      providers: [
        {
          provide: ContributorsService,
          useValue: service,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ContributorsController>(ContributorsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should call findAll', async () => {
    const res = await controller.findAll({});
    expect(res).toEqual({ items: [mockContributor], total: 1 });
    expect(service['findAll']).toHaveBeenCalled();
  });

  it('should call create', async () => {
    const dto = {
      displayName: 'Homer',
      identityConfidence: ContributorIdentityConfidenceDto.CONFIRMED,
    };
    const res = await controller.create(dto);
    expect(res).toEqual(mockContributor);
    expect(service['create']).toHaveBeenCalledWith(dto);
  });

  it('should call findOne', async () => {
    const res = await controller.findOne('contributor-1');
    expect(res).toEqual(mockContributor);
    expect(service['findOne']).toHaveBeenCalledWith('contributor-1');
  });

  it('should call update', async () => {
    const dto = { displayName: 'Homer 2' };
    const res = await controller.update('contributor-1', dto);
    expect(res).toEqual({ id: 'contributor-1', displayName: 'Homer 2' });
    expect(service['update']).toHaveBeenCalledWith('contributor-1', dto);
  });

  it('should call remove', async () => {
    const res = await controller.remove('contributor-1');
    expect(res).toEqual(mockContributor);
    expect(service['remove']).toHaveBeenCalledWith('contributor-1');
  });

  it('should call linkSourceEdition', async () => {
    const dto = { contributorId: 'c1', role: ContributorRoleDto.AUTHOR };
    const res = await controller.linkSourceEdition('se-1', dto);
    expect(res).toEqual({ id: 'sec-1' });
    expect(service['linkSourceEdition']).toHaveBeenCalledWith('se-1', dto);
  });

  it('should call linkRightsComponent', async () => {
    const dto = { contributorId: 'c1', role: ContributorRoleDto.TRANSLATOR };
    const res = await controller.linkRightsComponent('rc-1', dto);
    expect(res).toEqual({ id: 'rcc-1' });
    expect(service['linkRightsComponent']).toHaveBeenCalledWith('rc-1', dto);
  });
});
