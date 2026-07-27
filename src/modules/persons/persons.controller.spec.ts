import { Test, TestingModule } from '@nestjs/testing';
import { PersonsController } from './persons.controller';
import { PersonsService } from './persons.service';
import { PersonType } from './person-interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

describe('PersonsController', () => {
  let controller: PersonsController;
  let serviceMock: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    search: jest.Mock;
  };

  beforeEach(async () => {
    serviceMock = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      search: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PersonsController],
      providers: [{ provide: PersonsService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PersonsController>(PersonsController);
  });

  it('should return paginated list of persons', async () => {
    const response = {
      items: [{ id: '1', canonicalName: 'Mark Twain', type: PersonType.NATURAL_PERSON }],
      total: 1,
      limit: 20,
      offset: 0,
    };
    serviceMock.findAll.mockResolvedValueOnce(response);

    const result = await controller.findAll({ limit: 20, offset: 0 });
    expect(serviceMock.findAll).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    expect(result).toEqual(response);
  });

  it('should search persons by query', async () => {
    const response = { items: [], total: 0, limit: 20, offset: 0 };
    serviceMock.search.mockResolvedValueOnce(response);

    const result = await controller.search('Twain');
    expect(serviceMock.search).toHaveBeenCalledWith('Twain');
    expect(result).toEqual(response);
  });

  it('should return person details by id', async () => {
    const person = { id: '1', canonicalName: 'Mark Twain', translations: [] };
    serviceMock.findOne.mockResolvedValueOnce(person);

    const result = await controller.findOne('1');
    expect(serviceMock.findOne).toHaveBeenCalledWith('1');
    expect(result).toEqual(person);
  });

  it('should create a person', async () => {
    const dto = { canonicalName: 'Mark Twain' };
    const created = { id: '1', ...dto };
    serviceMock.create.mockResolvedValueOnce(created);

    const result = await controller.create(dto);
    expect(serviceMock.create).toHaveBeenCalledWith(dto);
    expect(result).toEqual(created);
  });

  it('should update a person', async () => {
    const dto = { canonicalName: 'Samuel Clemens' };
    const updated = { id: '1', ...dto };
    serviceMock.update.mockResolvedValueOnce(updated);

    const result = await controller.update('1', dto);
    expect(serviceMock.update).toHaveBeenCalledWith('1', dto);
    expect(result).toEqual(updated);
  });
});
