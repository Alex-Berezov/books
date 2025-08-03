import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';

@Injectable()
export class BookService {
  constructor(private prisma: PrismaService) {}

  async create(data: CreateBookDto) {
    return this.prisma.book.create({ data });
  }

  async findAll() {
    return this.prisma.book.findMany();
  }

  async findOne(id: string) {
    return this.prisma.book.findUnique({ where: { id } });
  }

  async update(id: string, data: UpdateBookDto) {
    return this.prisma.book.update({ where: { id }, data });
  }

  async remove(id: string) {
    return this.prisma.book.delete({ where: { id } });
  }
}
