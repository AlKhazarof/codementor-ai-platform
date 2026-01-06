const mongoose = require('mongoose')

const OrganizationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens']
  },
  logo: String,
  domain: {
    type: String,
    sparse: true,
    unique: true
  },
  plan: {
    type: String,
    enum: ['enterprise', 'team'],
    default: 'team'
  },
  subscription: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subscription',
    required: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  members: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'instructor', 'member'],
      default: 'member'
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['active', 'invited', 'suspended'],
      default: 'active'
    }
  }],
  teams: [{
    name: String,
    description: String,
    members: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  settings: {
    sso: {
      enabled: { type: Boolean, default: false },
      provider: String,
      metadata: mongoose.Schema.Types.Mixed
    },
    security: {
      enforcePasswordPolicy: { type: Boolean, default: false },
      requireMFA: { type: Boolean, default: false },
      sessionTimeout: { type: Number, default: 480 },
      allowedIPs: [String]
    },
    branding: {
      primaryColor: String,
      secondaryColor: String,
      customLogo: String,
      customFavicon: String
    },
    integrations: {
      slack: {
        enabled: { type: Boolean, default: false },
        webhookUrl: String
      },
      github: {
        enabled: { type: Boolean, default: false },
        orgName: String
      },
      lms: {
        enabled: { type: Boolean, default: false },
        provider: String,
        apiKey: String
      }
    }
  },
  billing: {
    seats: { type: Number, default: 5 },
    usedSeats: { type: Number, default: 1 },
    billingEmail: String,
    billingAddress: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      postalCode: String,
      country: String
    },
    taxId: String
  },
  limits: {
    maxMembers: { type: Number, default: 50 },
    maxTeams: { type: Number, default: 10 },
    maxProjects: { type: Number, default: 100 },
    storageGB: { type: Number, default: 100 }
  },
  usage: {
    currentMembers: { type: Number, default: 1 },
    currentTeams: { type: Number, default: 0 },
    currentProjects: { type: Number, default: 0 },
    storageUsedGB: { type: Number, default: 0 }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  contract: {
    startDate: Date,
    endDate: Date,
    acv: Number,
    terms: String,
    signedBy: String,
    signedAt: Date
  },
  salesInfo: {
    accountManager: String,
    leadSource: String,
    industry: String,
    companySize: String,
    notes: String
  }
}, {
  timestamps: true
})

OrganizationSchema.index({ slug: 1 })
OrganizationSchema.index({ owner: 1 })
OrganizationSchema.index({ 'members.userId': 1 })
OrganizationSchema.index({ isActive: 1, plan: 1 })

OrganizationSchema.virtual('memberCount').get(function() {
  return this.members.filter(m => m.status === 'active').length
})

OrganizationSchema.methods.addMember = function(userId, role = 'member', invitedBy) {
  if (this.members.some(m => m.userId.equals(userId))) {
    throw new Error('User is already a member')
  }
  
  if (this.usage.currentMembers >= this.limits.maxMembers) {
    throw new Error('Maximum member limit reached')
  }
  
  this.members.push({
    userId,
    role,
    invitedBy,
    status: 'active'
  })
  
  this.usage.currentMembers += 1
  return this.save()
}

OrganizationSchema.methods.removeMember = function(userId) {
  const index = this.members.findIndex(m => m.userId.equals(userId))
  if (index === -1) {
    throw new Error('User is not a member')
  }
  
  if (this.members[index].role === 'owner') {
    throw new Error('Cannot remove owner')
  }
  
  this.members.splice(index, 1)
  this.usage.currentMembers = Math.max(0, this.usage.currentMembers - 1)
  return this.save()
}

OrganizationSchema.methods.getMember = function(userId) {
  return this.members.find(m => m.userId.equals(userId))
}

OrganizationSchema.methods.hasPermission = function(userId, permission) {
  const member = this.getMember(userId)
  if (!member) return false
  
  const rolePermissions = {
    owner: ['*'],
    admin: ['manage_members', 'manage_teams', 'manage_settings', 'view_billing'],
    instructor: ['create_content', 'manage_teams', 'view_analytics'],
    member: ['view_content', 'submit_work']
  }
  
  const permissions = rolePermissions[member.role] || []
  return permissions.includes('*') || permissions.includes(permission)
}

OrganizationSchema.statics.getTotalACV = async function() {
  const result = await this.aggregate([
    {
      $match: {
        isActive: true,
        'contract.acv': { $exists: true, $gt: 0 }
      }
    },
    {
      $group: {
        _id: null,
        totalACV: { $sum: '$contract.acv' },
        customerCount: { $sum: 1 }
      }
    }
  ])
  
  return result[0] || { totalACV: 0, customerCount: 0 }
}

module.exports = mongoose.model('Organization', OrganizationSchema)
