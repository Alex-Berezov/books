export interface FAQItem {
  question: string;
  answer: string;
}

export function generateFAQSchema(items: FAQItem[], pageIdUrl: string): Record<string, unknown> {
  return {
    '@type': 'FAQPage',
    '@id': `${pageIdUrl}#faq`,
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}
