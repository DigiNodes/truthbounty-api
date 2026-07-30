import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { ContextDocument, ContextDocumentCategory } from '../ai-assistant/entities/context-document.entity';

// Load environment variables
config();

/**
 * Seed script for the AI Assistant knowledge base.
 *
 * Populates ai_context_documents with one sample document per category so
 * ContextRetrievalService has a real corpus to search against out of the box.
 *
 * Usage: npm run seed:ai
 */

const dataSource = new DataSource({
  type: 'sqlite',
  database: process.env.DATABASE_PATH || 'database.sqlite',
  entities: [ContextDocument],
  synchronize: true,
  logging: false,
});

const documents: Partial<ContextDocument>[] = [
  {
    title: 'What is TruthBounty?',
    category: ContextDocumentCategory.PROTOCOL_DOCS,
    content:
      'TruthBounty is a decentralized news verification protocol. Contributors submit claims, provide evidence, and vote on outcomes. Verified claims build contributor reputation and can trigger staking rewards; disputed claims go through a structured review process.',
    tags: ['overview', 'protocol', 'introduction'],
    sourceUrl: undefined,
  },
  {
    title: 'How governance proposals work',
    category: ContextDocumentCategory.GOVERNANCE,
    content:
      'Governance proposals let token holders and high-reputation contributors suggest changes to protocol parameters (e.g. staking ratios, dispute thresholds). Proposals move through discussion, voting, and execution phases. Quorum and approval thresholds are configurable per proposal type.',
    tags: ['governance', 'proposals', 'voting'],
    sourceUrl: undefined,
  },
  {
    title: 'Understanding reputation scores',
    category: ContextDocumentCategory.KNOWLEDGE_BASE,
    content:
      'Reputation reflects a contributor\'s track record of accurate claims and evidence. It factors in claim accuracy, dispute outcomes, and account age. Higher reputation unlocks larger staking limits and moderation-assist privileges.',
    tags: ['reputation', 'scoring'],
    sourceUrl: undefined,
  },
  {
    title: 'Submitting your first claim',
    category: ContextDocumentCategory.CONTRIBUTOR_GUIDE,
    content:
      'To submit a claim: connect your wallet, describe the claim clearly and neutrally, attach supporting evidence (links, documents, or media), and submit. Other contributors will review, vote, and may request additional evidence before a claim is finalized.',
    tags: ['getting-started', 'claims', 'guide'],
    sourceUrl: undefined,
  },
  {
    title: 'Claims API overview',
    category: ContextDocumentCategory.API_DOCS,
    content:
      'The Claims API exposes endpoints for creating claims, attaching evidence, and querying claim status. All mutating endpoints require a wallet-signed JWT. See /api for the full OpenAPI schema and request/response examples.',
    tags: ['api', 'claims', 'developer'],
    sourceUrl: undefined,
  },
  {
    title: 'Moderation policy for disputed claims',
    category: ContextDocumentCategory.MODERATION_POLICY,
    content:
      'Moderators triage disputes flagged for low confidence or minority opposition. Review criteria include evidence quality, source credibility, and voting pattern anomalies (possible sybil behavior). Moderators may request re-review but cannot unilaterally overturn a finalized outcome.',
    tags: ['moderation', 'disputes', 'policy'],
    sourceUrl: undefined,
  },
  {
    title: 'Frequently asked questions',
    category: ContextDocumentCategory.FAQ,
    content:
      'Q: Can I edit a claim after submission? A: No, submit a correction as new evidence instead. Q: What happens if my claim is disputed? A: It enters the dispute review flow described in the moderation policy. Q: How is staking risk calculated? A: Based on claim confidence and historical accuracy of similar claims.',
    tags: ['faq'],
    sourceUrl: undefined,
  },
];

async function seed() {
  console.log('🌱 Seeding AI assistant knowledge base...');

  try {
    await dataSource.initialize();
    console.log('✅ Database connection established');

    const repository = dataSource.getRepository(ContextDocument);

    const shouldClear = process.argv.includes('--clear');
    if (shouldClear) {
      console.log('🗑️  Clearing existing knowledge-base documents...');
      await repository.delete({});
    }

    for (const doc of documents) {
      const exists = await repository.findOne({ where: { title: doc.title } });
      if (exists) {
        console.log(`↷ Skipping existing document: ${doc.title}`);
        continue;
      }
      await repository.save(repository.create(doc));
      console.log(`✅ Created: ${doc.title}`);
    }

    console.log(`\n🎉 Knowledge base now has ${await repository.count()} document(s).`);
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    await dataSource.destroy();
    console.log('👋 Database connection closed');
  }
}

seed();
