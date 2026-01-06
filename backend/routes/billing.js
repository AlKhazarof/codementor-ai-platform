const express = require('express')
const router = express.Router()
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const Subscription = require('../models/Subscription')
const User = require('../models/User')
const { authenticate } = require('../middleware/auth')

const PLANS = {
  free: {
    name: 'Free',
    prices: { monthly: 0, yearly: 0 },
    features: {
      maxProjects: 3,
      maxCollaborators: 0,
      aiTutorMinutes: 10,
      codeExecutions: 50,
      storageGB: 1,
      customDomains: 0,
      prioritySupport: false,
      advancedAnalytics: false,
      ssoEnabled: false,
      apiAccess: false
    }
  },
  starter: {
    name: 'Starter',
    prices: { monthly: 19, yearly: 190 },
    stripeIds: {
      monthly: { USD: 'price_starter_monthly_usd', EUR: 'price_starter_monthly_eur' },
      yearly: { USD: 'price_starter_yearly_usd', EUR: 'price_starter_yearly_eur' }
    },
    features: {
      maxProjects: 10,
      maxCollaborators: 2,
      aiTutorMinutes: 100,
      codeExecutions: 500,
      storageGB: 10,
      customDomains: 1,
      prioritySupport: false,
      advancedAnalytics: true,
      ssoEnabled: false,
      apiAccess: false
    }
  },
  pro: {
    name: 'Pro',
    prices: { monthly: 49, yearly: 490 },
    stripeIds: {
      monthly: { USD: 'price_pro_monthly_usd', EUR: 'price_pro_monthly_eur' },
      yearly: { USD: 'price_pro_yearly_usd', EUR: 'price_pro_yearly_eur' }
    },
    features: {
      maxProjects: 50,
      maxCollaborators: 10,
      aiTutorMinutes: 500,
      codeExecutions: 5000,
      storageGB: 100,
      customDomains: 5,
      prioritySupport: true,
      advancedAnalytics: true,
      ssoEnabled: false,
      apiAccess: true
    }
  },
  enterprise: {
    name: 'Enterprise',
    prices: { monthly: 499, yearly: 4990 },
    features: {
      maxProjects: 999999,
      maxCollaborators: 999999,
      aiTutorMinutes: 999999,
      codeExecutions: 999999,
      storageGB: 1000,
      customDomains: 999999,
      prioritySupport: true,
      advancedAnalytics: true,
      ssoEnabled: true,
      apiAccess: true,
      whiteLabeling: true,
      dedicatedManager: true
    }
  }
}

router.get('/plans', (req, res) => {
  res.json({
    success: true,
    plans: PLANS
  })
})

router.post('/create-checkout-session', authenticate, async (req, res) => {
  try {
    const { plan, billingCycle = 'monthly', currency = 'USD' } = req.body
    
    if (!PLANS[plan] || plan === 'free') {
      return res.status(400).json({
        success: false,
        message: 'Invalid plan selected'
      })
    }
    
    let customer
    const existingSubscription = await Subscription.findOne({
      userId: req.user._id,
      status: 'active'
    })
    
    if (existingSubscription?.stripeCustomerId) {
      customer = await stripe.customers.retrieve(existingSubscription.stripeCustomerId)
    } else {
      customer = await stripe.customers.create({
        email: req.user.email,
        metadata: {
          userId: req.user._id.toString(),
          username: req.user.username
        }
      })
    }
    
    const priceId = PLANS[plan].stripeIds?.[billingCycle]?.[currency]
    if (!priceId) {
      return res.status(400).json({
        success: false,
        message: 'Price not configured for this plan'
      })
    }
    
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/dashboard/billing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: {
        userId: req.user._id.toString(),
        plan,
        billingCycle,
        currency
      },
      subscription_data: {
        trial_period_days: plan === 'starter' || plan === 'pro' ? 14 : 0,
        metadata: {
          userId: req.user._id.toString(),
          plan
        }
      }
    })
    
    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    })
  } catch (error) {
    console.error('Checkout error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to create checkout session',
      error: error.message
    })
  }
})

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event
  
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }
  
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        await handleCheckoutComplete(session)
        break
      }
      
      case 'customer.subscription.updated': {
        const subscription = event.data.object
        await handleSubscriptionUpdate(subscription)
        break
      }
      
      case 'customer.subscription.deleted': {
        const subscription = event.data.object
        await handleSubscriptionDeleted(subscription)
        break
      }
      
      case 'invoice.paid': {
        const invoice = event.data.object
        await handleInvoicePaid(invoice)
        break
      }
      
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        await handlePaymentFailed(invoice)
        break
      }
    }
    
    res.json({ received: true })
  } catch (error) {
    console.error('Webhook processing error:', error)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
})

async function handleCheckoutComplete(session) {
  const userId = session.metadata.userId
  const plan = session.metadata.plan
  const billingCycle = session.metadata.billingCycle
  const currency = session.metadata.currency || 'USD'
  
  const stripeSubscription = await stripe.subscriptions.retrieve(session.subscription)
  
  const amount = PLANS[plan].prices[billingCycle]
  const mrr = billingCycle === 'yearly' ? amount / 12 : amount
  
  const periodEnd = new Date(stripeSubscription.current_period_end * 1000)
  
  await Subscription.findOneAndUpdate(
    { userId },
    {
      plan,
      status: 'active',
      billingCycle,
      currency,
      amount,
      mrr,
      stripeCustomerId: session.customer,
      stripeSubscriptionId: session.subscription,
      currentPeriodStart: new Date(stripeSubscription.current_period_start * 1000),
      currentPeriodEnd: periodEnd,
      trialEnd: stripeSubscription.trial_end ? new Date(stripeSubscription.trial_end * 1000) : null,
      features: PLANS[plan].features
    },
    { upsert: true, new: true }
  )
  
  await User.findByIdAndUpdate(userId, {
    'subscription.plan': plan,
    'subscription.startDate': new Date(),
    'subscription.endDate': periodEnd,
    'subscription.features': Object.keys(PLANS[plan].features)
  })
}

async function handleSubscriptionUpdate(stripeSubscription) {
  const subscription = await Subscription.findOne({
    stripeSubscriptionId: stripeSubscription.id
  })
  
  if (!subscription) return
  
  subscription.status = stripeSubscription.status
  subscription.currentPeriodStart = new Date(stripeSubscription.current_period_start * 1000)
  subscription.currentPeriodEnd = new Date(stripeSubscription.current_period_end * 1000)
  subscription.cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end
  
  if (stripeSubscription.canceled_at) {
    subscription.canceledAt = new Date(stripeSubscription.canceled_at * 1000)
  }
  
  await subscription.save()
}

async function handleSubscriptionDeleted(stripeSubscription) {
  const subscription = await Subscription.findOne({
    stripeSubscriptionId: stripeSubscription.id
  })
  
  if (!subscription) return
  
  subscription.status = 'canceled'
  subscription.canceledAt = new Date()
  await subscription.save()
  
  await User.findByIdAndUpdate(subscription.userId, {
    'subscription.plan': 'free',
    'subscription.endDate': new Date()
  })
}

async function handleInvoicePaid(invoice) {
  console.log('Invoice paid:', invoice.id)
}

async function handlePaymentFailed(invoice) {
  const subscription = await Subscription.findOne({
    stripeCustomerId: invoice.customer
  })
  
  if (subscription) {
    subscription.status = 'past_due'
    await subscription.save()
  }
}

router.get('/subscription', authenticate, async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      userId: req.user._id
    }).sort({ createdAt: -1 })
    
    if (!subscription) {
      return res.json({
        success: true,
        subscription: {
          plan: 'free',
          status: 'active',
          features: PLANS.free.features
        }
      })
    }
    
    res.json({
      success: true,
      subscription
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch subscription',
      error: error.message
    })
  }
})

router.post('/cancel', authenticate, async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      userId: req.user._id,
      status: 'active'
    })
    
    if (!subscription || !subscription.stripeSubscriptionId) {
      return res.status(404).json({
        success: false,
        message: 'No active subscription found'
      })
    }
    
    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      cancel_at_period_end: true
    })
    
    subscription.cancelAtPeriodEnd = true
    await subscription.save()
    
    res.json({
      success: true,
      message: 'Subscription will be canceled at period end',
      subscription
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to cancel subscription',
      error: error.message
    })
  }
})

router.get('/metrics', authenticate, async (req, res) => {
  try {
    if (!req.user.roles.includes('admin')) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      })
    }
    
    const [mrrData, arr, churnRate] = await Promise.all([
      Subscription.getMRR(),
      Subscription.getARR(),
      Subscription.getChurnRate()
    ])
    
    res.json({
      success: true,
      metrics: {
        mrr: mrrData.totalMRR,
        arr,
        subscribers: mrrData.subscriberCount,
        churnRate
      }
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch metrics',
      error: error.message
    })
  }
})

module.exports = router
