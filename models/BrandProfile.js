import mongoose from 'mongoose';

const BrandProfileSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAgentWorkspace', required: true },
  companyName: { type: String },
  website: { type: String },
  companyOverviewText: { type: String },
  companyOverviewFileUrl: { type: String },
  companyOverviewFileUrls: [String],
  logoUrl: { type: String },
  brandColors: [String],
  themePreference: { type: String },
  toneOfVoice: { type: String },
  ctaStyle: { type: String },
  dosAndDonts: { type: String },
  extractedBrandSummary: { type: String },
  // Preference Memory (Phase 3)
  preferredTone: { type: String },
  preferredHookStyle: { type: String },
  preferredCtaStyle: { type: String },
  preferredVisualDirection: { type: String },
  preferredLogoPlacement: { 
    type: String, 
    enum: ['Top-Left', 'Top-Right', 'Bottom-Left', 'Bottom-Right', 'None'],
    default: 'Top-Right'
  },
  brandSafeWordRules: [String],
  targetEthnicity: { type: String, default: 'Global' },
  postApprovalRequired: { type: Boolean, default: true },
  defaultSchedulingTime: { type: String, default: '10:00 AM' },
  fontFamily: { type: String, default: 'Inter' },
  
  // NEW STRATEGIC INPUTS
  targetIndustry: { type: String },
  targetAudience: { type: String },
  contentObjective: { type: String },
  campaignMonth: { type: String },
  postingFrequency: { type: String },
  
  // THE CORE BASE: FINAL STRUCTURED IDENTITY
  structuredIdentity: {
    brand_name: { type: String },
    industry: { type: String },
    target_audience: { type: String },
    tone: { type: String },
    cta_style: { type: String },
    products_services: [String],
    brand_values: [String],
    content_angles: [String],
    color_palette: [String],
    platform_focus: { type: [String], default: ['instagram', 'linkedin', 'twitter'] },
    posting_frequency: { type: String, default: 'daily' },
    goal: { type: String, default: 'engagement + awareness + conversion' }
  }
}, { timestamps: true });

export default mongoose.models.BrandProfile || mongoose.model('BrandProfile', BrandProfileSchema);
