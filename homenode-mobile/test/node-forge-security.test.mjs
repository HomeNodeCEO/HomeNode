import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, privateEncrypt } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const signingRequire = createRequire(cliRequire.resolve('@expo/code-signing-certificates'));
const pem = generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicExponent: 3,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const payload = Buffer.from('HomeNode synthetic signature regression');
const digest = createHash('sha256').update(payload).digest('latin1');

// These tests use a generated test private key to sign malformed encodings.
// They verify parser rejection, not a demonstrated forgery without that key.
for (const [name, resolve] of [['Expo CLI', cliRequire], ['Expo code signing', signingRequire]]) {
  const forge = resolve('node-forge');
  const publicKey = forge.pki.publicKeyFromPem(pem.publicKey);
  const { asn1 } = forge;
  const node = (type, constructed, value) => asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);
  const oid = () => node(asn1.Type.OID, false, asn1.oidToDer(forge.oids.sha256).getBytes());
  const nullValue = (value = '') => node(asn1.Type.NULL, false, value);
  const extra = () => node(asn1.Type.OCTETSTRING, false, 'unexpected');
  const signEncoding = (algorithm, outerExtras = []) => {
    const der = Buffer.from(asn1.toDer(node(asn1.Type.SEQUENCE, true, [
      node(asn1.Type.SEQUENCE, true, algorithm),
      node(asn1.Type.OCTETSTRING, false, digest),
      ...outerExtras,
    ])).getBytes(), 'latin1');
    const encoded = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(128 - der.length - 3, 0xff), Buffer.from([0]), der]);
    return privateEncrypt({ key: pem.privateKey, padding: constants.RSA_NO_PADDING }, encoded).toString('latin1');
  };

  test(`${name} accepts valid SHA-256 algorithm parameters and rejects changed digests`, () => {
    for (const algorithm of [[oid()], [oid(), nullValue()]]) {
      const signature = signEncoding(algorithm);
      assert.equal(publicKey.verify(digest, signature), true);
      assert.equal(publicKey.verify(createHash('sha256').update('changed').digest('latin1'), signature), false);
    }
  });

  for (const [label, algorithm] of [
    ['extra child after NULL', [oid(), nullValue(), extra()]],
    ['extra child without NULL', [oid(), extra()]],
    ['duplicate NULL', [oid(), nullValue(), nullValue()]],
    ['nonempty NULL', [oid(), nullValue('x')]],
    ['larger nonempty NULL', [oid(), nullValue('x'.repeat(32))]],
  ]) {
    test(`${name} rejects DigestAlgorithm ${label}`, () => {
      assert.throws(() => publicKey.verify(digest, signEncoding(algorithm)), /DigestInfo/);
    });
  }

  test(`${name} continues rejecting extra outer DigestInfo elements`, () => {
    assert.throws(() => publicKey.verify(digest, signEncoding([oid(), nullValue()], [extra()])), /DigestInfo/);
  });

  test(`${name} preserves RSA-PSS signing and verification`, () => {
    const privateKey = forge.pki.privateKeyFromPem(pem.privateKey);
    const pss = () => forge.pss.create({ md: forge.md.sha256.create(), mgf: forge.mgf.mgf1.create(forge.md.sha256.create()), saltLength: 20 });
    const hash = forge.md.sha256.create().update(payload.toString('latin1'));
    const signature = privateKey.sign(hash, pss());
    assert.equal(publicKey.verify(digest, signature, pss()), true);
  });
}

test('Expo certificate, CSR and signed-buffer workflows remain compatible', () => {
  const signing = cliRequire('@expo/code-signing-certificates');
  const keyPair = signing.convertKeyPairPEMToKeyPair({ publicKeyPEM: pem.publicKey, privateKeyPEM: pem.privateKey });
  const certificate = signing.generateSelfSignedCodeSigningCertificate({
    keyPair,
    validityNotBefore: new Date(Date.now() - 60_000),
    validityNotAfter: new Date(Date.now() + 60_000),
    commonName: 'HomeNode synthetic test',
  });
  assert.doesNotThrow(() => signing.validateSelfSignedCertificate(certificate, keyPair));
  assert.equal(signing.generateCSR(keyPair, 'HomeNode synthetic test').verify(), true);
  assert.ok(signing.signBufferRSASHA256AndVerify(keyPair.privateKey, certificate, payload));
});
