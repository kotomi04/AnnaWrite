# Reserved for shared code

When two or more apps in this monorepo start duplicating UI components, manifest helpers, or storage wrappers, lift them into a package here:

```
packages/
├── ui-kit/             # shared CSS / web components for window chrome
├── storage-helpers/    # wrappers around anna.storage.* with the `exists` fix
└── executa-common/     # JSON-RPC stdio loop, dispatch helpers, error mapping
```

Avoid premature abstraction — first app to need a helper inlines it; second app extracts it here.
