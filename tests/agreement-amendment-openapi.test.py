"""Validate concrete amendment DTOs, real isolated samples and strict endpoint contracts."""
import copy,json,unittest
from pathlib import Path
from jsonschema import Draft202012Validator,FormatChecker
ROOT=Path(__file__).resolve().parents[1]
SPEC=json.loads((ROOT/'docs/backend-openapi.json').read_text())
def validator(name):
 schema={'$ref':'#/components/schemas/'+name,'components':SPEC['components']}
 Draft202012Validator.check_schema(schema)
 return Draft202012Validator(schema,format_checker=FormatChecker())
class AmendmentAPI(unittest.TestCase):
 def test_all_concrete_response_schemas(self):
  for name in ['AgreementCapabilities','AgreementFunding','AgreementTerms','AgreementAmendment','AmendmentEvent','AmendmentReceipt','AmendmentCommandResult','AgreementTermsPage','AgreementAmendmentsPage','AmendmentEventsPage','AgreementDetail','AgreementSubmission']:
   validator(name)
 def test_actual_isolated_service_samples(self):
  samples=sorted((ROOT/'.superpowers/sdd/interaction-round13-plan/task-2-fix1-evidence').glob('dto-samples-campus_r13_*.json'))
  self.assertTrue(samples,'Run scoped isolated service tests to obtain real DTO samples')
  for file in samples:
   for name,sample in json.loads(file.read_text()).items():
    with self.subTest(file=file.name,schema=name):validator(name).validate(sample)
 def test_monetary_truth_and_capability_fields(self):
  v=validator('AgreementCapabilities');v.validate({'agreementAmendments':False,'agreementTermsBinding':'legacy','schemaRequirement':17})
  self.assertFalse(v.is_valid({'agreementAmendments':True,'agreementTermsBinding':'legacy','schemaRequirement':16}))
  f={'authority':'unavailable','coverage':'unknown','agreementActivation':'active','requirement':'funding_reconciliation','changeKind':'increase','rewardDeltaCents':100,'additionalFundingCents':None,'refundCents':None,'allocationChanged':True,'canExecutePayment':False}
  v=validator('AgreementFunding');v.validate(f)
  for field,value in [('additionalFundingCents',100),('refundCents',0),('canExecutePayment',True),('coverage','funded')]:self.assertFalse(v.is_valid({**f,field:value}))
 def test_resource_routes_strict_requests_and_pagination(self):
  paths=SPEC['paths'];base='/agreements/{id}/amendments';specific=base+'/{amendmentId}'
  expected={base:['get','post'],specific:['get'],specific+'/events':['get'],specific+'/revisions':['post'],specific+'/confirmations':['post'],specific+'/rejections':['post'],specific+'/withdrawals':['post'],'/capabilities':['get'],'/agreements/{id}/terms':['get'],'/agreements/{id}/terms/{revision}':['get']}
  for path,verbs in expected.items():
   for verb in verbs:
    with self.subTest(path=path,verb=verb):
     op=paths[path][verb];self.assertTrue(op['security']);self.assertIn('503',op['responses'])
     responses=[r for status,r in op['responses'].items() if status.startswith('2')];self.assertTrue(responses)
     for response in responses:self.assertIn('$ref',response['content']['application/json']['schema'])
     if verb=='post':self.assertFalse(op['requestBody']['content']['application/json']['schema']['additionalProperties']);self.assertTrue(any(x['name']=='Idempotency-Key' for x in op['parameters']))
  for path in [base,specific+'/events','/agreements/{id}/terms']:
   params={p['name']:p for p in paths[path]['get']['parameters']};self.assertEqual(params['limit']['schema']['maximum'],50);self.assertEqual(params['cursor']['schema']['maxLength'],1024)
 def test_new_work_identity_fields_are_documented_and_legacy_recovery_preserved(self):
  for path,fields in [('/milestones/{id}/submissions',['expectedEffectiveTermsId','expectedEffectiveRevision']),('/milestones/{id}/acceptance',['submissionTermsId','submissionTermsRevision']),('/milestones/{id}/revision-requests',['submissionTermsId','submissionTermsRevision'])]:
   op=SPEC['paths'][path]['post'];schema=op['requestBody']['content']['application/json']['schema']
   for field in fields:self.assertIn(field,schema['properties']);self.assertNotIn(field,schema['required'])
   self.assertIn('exact old normalized successful receipts',op['description'])
if __name__=='__main__':unittest.main(verbosity=2)
