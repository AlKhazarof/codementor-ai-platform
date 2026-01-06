const mongoose = require('mongoose')

const SubscriptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  plan: {
    type: String,
    enum: ['free', 'starter', 'pro', 'enterprise'],
    required: true,
    default: 'free'
  },
  status: {
    type: String,
    enum: ['active', 'canceled', 'past_due', 'trialing', 'expired', 'paused'],
    default: 'active',
    index: true
  },
  billingCycle: {
    type: String,
    enum: ['monthly', 'yearly'],
    default: 'monthly'
  },
  currency: {
    type: String,
    enum: ['USD', 'EUR', 'GBP', 'BRL', 'MXN'],
    default: 'USD'
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  mrr: {
    type: Number,
    default: 0
  },
  stripeCustomerId: {
    type: String,
    sparse: true,
    index: true
  },
  stripeSubscriptionId: {
    type: String,
    sparse: true,
    index: true
  },
  stripePaymentMethodId: String,
  startDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  currentPeriodStart: {
    type: Date,
    required: true,
    default: Date.now
  },
  currentPeriodEnd: {
    type: Date,
    required: true,
    index: true
  },
  trialEnd: Date,
  canceledAt: Date,
  cancelAtPeriodEnd: {
    type: Boolean,
    default: false
  },
  features: {
    maxProjects: { type: Number, default: 3 },
    maxCollaborators: { type: Number, default: 0 },
    aiTutorMinutes: { type: Number, default: 10 },
    codeExecutions: { type: Number, default: 50 },
    storageGB: { type: Number, default: 1 },
    customDomains: { type: Number, default: 0 },
    prioritySupport: { type: Boolean, default: false },
    advancedAnalytics: { type: Boolean, default: false },
    ssoEnabled: { type: Boolean, default: false },
    apiAccess: { type: Boolean, default: false },
    whiteLabeling: { type: Boolean, default: false },
    dedicatedManager: { type: Boolean, default: false }
  },
  usage: {
    currentProjects: { type: Number, default: 0 },
    aiTutorMinutesUsed: { type: Number, default: 0 },
    codeExecutionsUsed: { type: Number, default: 0 },
    storageUsedGB: { type: Number, default: 0 },
    lastResetDate: { type: Date, default: Date.now }
  },
  companyInfo: {
    name: String,
    size: {
      type: String,
      enum: ['1-10', '11-50', '51-200', '201-1000', '1000+']
    },
    industry: String,
    country: String,
    vatId: String
  },
  metadata: {
    source: String,
    campaign: String,
    referrer: String,
    notes: String
  }
}, {
  timestamps: true
})

SubscriptionSchema.index({ userId: 1, status: 1 })
SubscriptionSchema.index({ currentPeriodEnd: 1, status: 1 })
SubscriptionSchema.index({ createdAt: -1 })

SubscriptionSchema.virtual('isActive').get(function() {
  return this.status === 'active' && this.currentPeriodEnd > new Date()
})

SubscriptionSchema.virtual('daysRemaining').get(function() {
  const now = new Date()
  const diff = this.currentPeriodEnd - now
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
})

SubscriptionSchema.methods.resetUsage = function() {
  this.usage = {
    currentProjects: this.usage.currentProjects || 0,
    aiTutorMinutesUsed: 0,
    codeExecutionsUsed: 0,
    storageUsedGB: this.usage.storageUsedGB || 0,
    lastResetDate: new Date()
  }
  return this.save()
}

SubscriptionSchema.methods.canUseFeature = function(feature) {
  switch (feature) {
    case 'createProject':
      return this.usage.currentProjects < this.features.maxProjects
    case 'aiTutor':
      return this.usage.aiTutorMinutesUsed < this.features.aiTutorMinutes
    case 'codeExecution':
      return this.usage.codeExecutionsUsed < this.features.codeExecutions
    case 'prioritySupport':
      return this.features.prioritySupport
    case 'advancedAnalytics':
      return this.features.advancedAnalytics
    case 'sso':
      return this.features.ssoEnabled
    case 'api':
      return this.features.apiAccess
    default:
      return true
  }
}

SubscriptionSchema.statics.getMRR = async function() {
  const result = await this.aggregate([
    {
      $match: {
        status: 'active',
        plan: { $ne: 'free' }
      }
    },
    {
      $group: {
        _id: null,
        totalMRR: { $sum: '$mrr' },
        subscriberCount: { $sum: 1 }
      }
    }
  ])
  
  return result[0] || { totalMRR: 0, subscriberCount: 0 }
}

SubscriptionSchema.statics.getARR = async function() {
  const mrrData = await this.getMRR()
  return mrrData.totalMRR * 12
}

SubscriptionSchema.statics.getChurnRate = async function(months = 3) {
  const startDate = new Date()
  startDate.setMonth(startDate.getMonth() - months)
  
  const totalAtStart = await this.countDocuments({
    createdAt: { $lt: startDate },
    status: 'active'
  })
  
  const churned = await this.countDocuments({
    canceledAt: { $gte: startDate },
    status: { $in: ['canceled', 'expired'] }
  })
  
  return totalAtStart > 0 ? (churned / totalAtStart) * 100 : 0
}

module.exports = mongoose.model('Subscription', SubscriptionSchema)
